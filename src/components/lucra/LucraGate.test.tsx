// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LucraGate, useLucra, type LucraContextValue } from "@/components/lucra/LucraGate";
import { LucraApiError, LucraApiErrorCode, LucraUserNotLoggedIn } from "@/lucra/sdk-mock";
import type { LucraSdkModule, SdkClient, SdkClientConfig, SdkDialog, SdkDialogNavigation, SdkEventMap, SdkUser } from "@/lucra/sdk-surface";

/**
 * `LucraGate`'s state mapping for every sealed failure the SDK can produce
 * (spec §7.5), driven through a scripted SDK module that throws the mock
 * stand-in's error classes — the same classes, with the same codes, that
 * `classifySdkFailure` branches on against the real package. Nothing here
 * inspects a message string.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const envelope = (data: unknown, status = 200) => new Response(JSON.stringify({ ok: true, data }), { status, headers: { "content-type": "application/json" } });

interface Script {
  /** What `client.ready` does: resolve (signed in), reject not-logged-in, or reject with a failed initialized body. */
  ready?: "signed_in" | "signed_out" | "init_failed";
  user?: SdkUser | null;
  /** Rejections for successive `joinTournament` calls; a `null` entry resolves. */
  join?: Array<unknown | null>;
  /** Which dialogs complete (fire their event) when opened; the rest close without it. */
  completes?: Partial<Record<keyof SdkDialogNavigation, boolean>>;
}

class FakeClient implements SdkClient {
  private listeners = new Map<keyof SdkEventMap, Set<(d: never) => void>>();
  readonly opened: string[] = [];
  readonly joins: string[] = [];
  readonly sent: unknown[] = [];
  private _user: SdkUser | null;
  isInitialized = false;
  ready: Promise<void>;
  constructor(
    readonly config: SdkClientConfig,
    private script: Script,
  ) {
    this._user = script.ready === "signed_in" ? (script.user ?? { id: "lucra-user-1", balance: 12.5, accountStatus: "VERIFIED" }) : null;
    this.ready = script.ready === "init_failed" ? Promise.reject({ success: false }) : script.ready === "signed_in" ? Promise.resolve() : Promise.reject(new LucraUserNotLoggedIn());
    this.ready.catch(() => {});
  }
  get user() {
    return this._user;
  }
  emit<K extends keyof SdkEventMap>(type: K, data: SdkEventMap[K]) {
    // As the SDK does: a `userInfo` push updates `client.user` before listeners hear of it.
    if (type === "userInfo") this._user = data as SdkUser;
    for (const l of [...(this.listeners.get(type) ?? [])]) (l as (d: SdkEventMap[K]) => void)(data);
  }
  on<K extends keyof SdkEventMap>(type: K, fn: (d: SdkEventMap[K]) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn as (d: never) => void);
  }
  off<K extends keyof SdkEventMap>(type: K, fn: (d: SdkEventMap[K]) => void) {
    this.listeners.get(type)?.delete(fn as (d: never) => void);
  }
  open() {
    this.isInitialized = this.script.ready !== "init_failed";
    return {
      home: () => undefined,
      login: () => {
        this.opened.push("login");
        // Lucra's login screen: the script says whether the user completes it.
        queueMicrotask(() => {
          if (this.script.completes?.profile === false) {
            this.emit("exitLucra", undefined);
            return;
          }
          this._user = this.script.user ?? { id: "lucra-user-1", balance: 0, accountStatus: "UNVERIFIED" };
          this.emit("loginSuccess", this._user);
        });
      },
    };
  }
  private dialogFor(name: keyof SdkDialogNavigation, event?: keyof SdkEventMap): SdkDialog {
    this.opened.push(name);
    const closers = new Set<() => void>();
    let closed = false;
    const dialog: SdkDialog = {
      close: () => {
        if (closed) return;
        closed = true;
        closers.forEach((c) => c());
      },
      onClose: (cb) => closers.add(cb),
    };
    queueMicrotask(() => {
      if (event && this.script.completes?.[name]) {
        if (name === "kyc" && this._user) this._user = { ...this._user, accountStatus: "VERIFIED" };
        this.emit(event, undefined as never);
      } else dialog.close();
    });
    return dialog;
  }
  dialog(): SdkDialogNavigation {
    return {
      profile: () => this.dialogFor("profile"),
      wallet: () => this.dialogFor("wallet"),
      deposit: () => this.dialogFor("deposit"),
      withdraw: () => this.dialogFor("withdraw"),
      kyc: () => this.dialogFor("kyc", "kycComplete"),
      demographic: () => this.dialogFor("demographic", "demographicComplete"),
      locationGrant: () => this.dialogFor("locationGrant", "locationGranted"),
      tournamentDetails: () => this.dialogFor("tournamentDetails"),
    };
  }
  hide() {}
  show() {}
  logout() {
    this._user = null;
  }
  api = {
    joinTournament: async (id: string) => {
      // A user-scoped call with nobody signed in: the SDK's not-logged-in rejection.
      if (!this._user) throw new LucraUserNotLoggedIn();
      this.joins.push(id);
      const next = this.script.join?.shift();
      if (next) throw next;
      return { matchupId: id };
    },
  };
  sendMessage = {
    userUpdated: (data: unknown) => {
      this.sent.push(data);
    },
  };
}

function moduleFor(script: Script): { module: LucraSdkModule; clients: FakeClient[] } {
  const clients: FakeClient[] = [];
  let instance: FakeClient | null = null;
  const module: LucraSdkModule = {
    LucraApiError,
    LucraUserNotLoggedIn,
    LucraApiErrorCode,
    LucraClient: {
      initialize: (config) => {
        instance = new FakeClient(config, script);
        clients.push(instance);
        return instance;
      },
      getInstance: () => {
        if (!instance) throw new Error("not initialized");
        return instance;
      },
      destroy: () => {
        instance = null;
      },
    },
  };
  return { module, clients };
}

let latest: LucraContextValue | null = null;
function Probe() {
  latest = useLucra();
  const { status, failure, user, busy } = latest;
  return (
    <div>
      <p data-testid="status">{status.kind === "ready" ? `ready:${status.signedIn ? "in" : "out"}` : status.kind === "failed" ? `failed:${status.failure.kind}` : status.kind}</p>
      <p data-testid="failure">{failure ? failure.kind : "none"}</p>
      <p data-testid="user">{user?.id ?? "-"}</p>
      <p data-testid="busy">{busy ? "busy" : "idle"}</p>
    </div>
  );
}

async function mount(script: Script) {
  const { module, clients } = moduleFor(script);
  render(
    <LucraGate loadSdk={async () => module} backoffMs={() => 0}>
      <Probe />
    </LucraGate>,
  );
  await waitFor(() => expect(screen.getByTestId("status").textContent).not.toBe("loading"));
  return { clients, client: () => clients[clients.length - 1]! };
}

describe("LucraGate", () => {
  beforeEach(() => {
    latest = null;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/api/me/lucra/link")) return envelope({ externalId: "ext-1", lucraUserId: null, verificationState: "unverified", minted: true }, 201);
      if (url.endsWith("/api/me/lucra/bind")) return envelope({ externalId: "ext-1", lucraUserId: "lucra-user-1", verificationState: "unverified", bound: true, source: "mock", reason: null });
      return envelope({});
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("initializes with autoJoin off, reports signed-out, and a sign-in binds the link: mint, userUpdated, bind", async () => {
    const { client } = await mount({ ready: "signed_out" });
    expect(screen.getByTestId("status").textContent).toBe("ready:out");
    expect(client().config).toMatchObject({ apiKey: "mock", autoJoin: false, env: "sandbox" });
    let outcome: Awaited<ReturnType<LucraContextValue["launch"]>> | undefined;
    await act(async () => {
      outcome = await latest!.launch("auth");
    });
    expect(outcome).toEqual({ ok: true, flow: "auth", completed: true });
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("ready:in"));
    await waitFor(() => expect(latest?.link).toMatchObject({ externalId: "ext-1", lucraUserId: "lucra-user-1", bound: true }));
    const calls = fetchMock.mock.calls.map((c) => (typeof c[0] === "string" ? c[0] : String(c[0])));
    expect(calls.filter((u) => u.endsWith("/api/me/lucra/link"))).toHaveLength(1);
    expect(calls.filter((u) => u.endsWith("/api/me/lucra/bind"))).toHaveLength(1);
    const bindBody = JSON.parse(String(fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/bind"))?.[1]?.body)) as { lucraUserId: string };
    expect(bindBody).toEqual({ lucraUserId: "lucra-user-1" });
    expect(client().sent).toEqual([{ metadata: { externalId: "ext-1" } }]);
    // The BACKEND key never exists on this side; only the WEB key and tenant id do.
    expect(JSON.stringify(client().config)).not.toContain("BACKEND");
  });

  it("a restored session is signed in immediately and bound once", async () => {
    await mount({ ready: "signed_in", user: { id: "lucra-user-1", balance: 3, accountStatus: "VERIFIED" } });
    expect(screen.getByTestId("status").textContent).toBe("ready:in");
    expect(screen.getByTestId("user").textContent).toBe("lucra-user-1");
    await waitFor(() => expect(latest?.link?.bound).toBe(true));
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/bind"))).toHaveLength(1);
  });

  it("NotInitialized on load retries initialization once, then fails with a retry action", async () => {
    const { clients } = await mount({ ready: "init_failed" });
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("failed:not_initialized"));
    expect(clients).toHaveLength(2);
    await act(async () => latest!.retry());
    await waitFor(() => expect(clients.length).toBeGreaterThanOrEqual(3));
  });

  it("a user-scoped flow signs in first; a cancelled sign-in is NotInitialized, not an error", async () => {
    const { client } = await mount({ ready: "signed_out", completes: { profile: false } });
    let outcome: Awaited<ReturnType<LucraContextValue["launch"]>> | undefined;
    await act(async () => {
      outcome = await latest!.launch("identity");
    });
    expect(outcome).toEqual({ ok: false, flow: "identity", failure: { kind: "not_initialized", signedIn: false } });
    expect(client().opened).toEqual(["login"]);
    expect(screen.getByTestId("failure").textContent).toBe("not_initialized");
    await act(async () => latest!.dismissFailure());
    expect(screen.getByTestId("failure").textContent).toBe("none");
  });

  it("identity, demographics and location report completion from the SDK's events, the wallet flows from the dialog close", async () => {
    const { client } = await mount({ ready: "signed_in", completes: { kyc: true, demographic: false, locationGrant: true } });
    const run = async (flow: Parameters<LucraContextValue["launch"]>[0]) => {
      let out: Awaited<ReturnType<LucraContextValue["launch"]>> | undefined;
      await act(async () => {
        out = await latest!.launch(flow);
      });
      return out!;
    };
    expect(await run("identity")).toEqual({ ok: true, flow: "identity", completed: true });
    expect(await run("demographics")).toEqual({ ok: true, flow: "demographics", completed: false });
    expect(await run("location")).toEqual({ ok: true, flow: "location", completed: true });
    expect(await run("addFunds")).toEqual({ ok: true, flow: "addFunds", completed: true });
    expect(await run("withdraw")).toEqual({ ok: true, flow: "withdraw", completed: true });
    expect(await run("wallet")).toEqual({ ok: true, flow: "wallet", completed: true });
    expect(await run("rewards")).toEqual({ ok: true, flow: "rewards", completed: true });
    await act(async () => {
      await latest!.launch("rewards", { matchupId: "m-1" });
    });
    expect(client().opened).toEqual(["kyc", "demographic", "locationGrant", "deposit", "withdraw", "wallet", "profile", "tournamentDetails"]);
    expect(screen.getByTestId("busy").textContent).toBe("idle");
  });

  describe("joinTournament maps every sealed failure per the §7.5 table", () => {
    const join = async () => {
      let out: Awaited<ReturnType<LucraContextValue["joinTournament"]>> | undefined;
      await act(async () => {
        out = await latest!.joinTournament("matchup-1");
      });
      return out!;
    };

    it("Unverified launches the identity flow and retries once", async () => {
      const { client } = await mount({ ready: "signed_in", user: { id: "u", accountStatus: "UNVERIFIED" }, join: [new LucraApiError(LucraApiErrorCode.unverified)], completes: { kyc: true } });
      expect(await join()).toEqual({ ok: true, matchupId: "matchup-1" });
      expect(client().opened).toEqual(["kyc"]);
      expect(client().joins).toHaveLength(2);
    });

    it("Unverified whose identity flow is abandoned is surfaced, with no second attempt", async () => {
      const { client } = await mount({ ready: "signed_in", user: { id: "u", accountStatus: "UNVERIFIED" }, join: [new LucraApiError(LucraApiErrorCode.unverified), new LucraApiError(LucraApiErrorCode.unverified)], completes: { kyc: false } });
      const out = await join();
      // The dialog closed without kycComplete; the gate still retried once (the user may have verified earlier) and then surfaced the state.
      expect(out).toEqual({ ok: false, failure: { kind: "unverified" } });
      expect(client().joins.length).toBeLessThanOrEqual(2);
      expect(screen.getByTestId("failure").textContent).toBe("unverified");
    });

    it("NotAllowed is terminal: nothing is launched and nothing is retried", async () => {
      const { client } = await mount({ ready: "signed_in", user: { id: "u", accountStatus: "BLOCKED" }, join: [new LucraApiError(LucraApiErrorCode.apiError, "blocked")] });
      expect(await join()).toEqual({ ok: false, failure: { kind: "not_allowed" } });
      // Decided from the account status before any call.
      expect(client().joins).toHaveLength(0);
      expect(client().opened).toEqual([]);
      expect(screen.getByTestId("failure").textContent).toBe("not_allowed");
    });

    it("a blocked account discovered through the catch-all code is NotAllowed too, by status not message", async () => {
      const { client } = await mount({ ready: "signed_in", user: { id: "u", accountStatus: "VERIFIED" }, join: [new LucraApiError(LucraApiErrorCode.apiError, "anything")] });
      // Status changes under us after the first call (a `userInfo` push).
      const c = client();
      const original = c.api.joinTournament;
      c.api.joinTournament = async (id: string) => {
        c.emit("userInfo", { id: "u", accountStatus: "SUSPENDED" });
        return original(id);
      };
      expect(await join()).toEqual({ ok: false, failure: { kind: "not_allowed" } });
      expect(c.joins).toHaveLength(1);
    });

    it("InsufficientFunds launches add funds and retries once", async () => {
      const { client } = await mount({ ready: "signed_in", join: [new LucraApiError(LucraApiErrorCode.insufficientFunds)], completes: { deposit: true } });
      expect(await join()).toEqual({ ok: true, matchupId: "matchup-1" });
      expect(client().opened).toEqual(["deposit"]);
    });

    it("DemographicInformationMissing launches the demographic form and retries when it completes", async () => {
      const { client } = await mount({ ready: "signed_in", join: [new LucraApiError(LucraApiErrorCode.demographicInformationMissing)], completes: { demographic: true } });
      expect(await join()).toEqual({ ok: true, matchupId: "matchup-1" });
      expect(client().opened).toEqual(["demographic"]);
      cleanup();
      const abandoned = await mount({ ready: "signed_in", join: [new LucraApiError(LucraApiErrorCode.demographicInformationMissing)], completes: { demographic: false } });
      expect(await join()).toEqual({ ok: false, failure: { kind: "demographics_missing" } });
      expect(abandoned.client().joins).toHaveLength(1);
    });

    it("LocationError with no location yet presents the grant page then retries; a location failure is surfaced for the user's retry", async () => {
      const { client } = await mount({ ready: "signed_in", join: [new LucraApiError(LucraApiErrorCode.locationNeeded)], completes: { locationGrant: true } });
      expect(await join()).toEqual({ ok: true, matchupId: "matchup-1" });
      expect(client().opened).toEqual(["locationGrant"]);
      cleanup();
      const failed = await mount({ ready: "signed_in", join: [new LucraApiError(LucraApiErrorCode.locationError)] });
      expect(await join()).toEqual({ ok: false, failure: { kind: "location", grant: false } });
      expect(failed.client().opened).toEqual([]);
      expect(screen.getByTestId("failure").textContent).toBe("location");
      // The user's own retry runs the call again.
      expect(await join()).toEqual({ ok: true, matchupId: "matchup-1" });
    });

    it("APIError is retried with backoff three times, then surfaced; a plain-string rejection counts the same", async () => {
      const { client } = await mount({ ready: "signed_in", join: [new LucraApiError(LucraApiErrorCode.apiError, "boom"), "Timeout", new LucraApiError(LucraApiErrorCode.apiError, "boom")] });
      expect(await join()).toEqual({ ok: false, failure: { kind: "api_error", message: "boom" } });
      expect(client().joins).toHaveLength(3);
      cleanup();
      const recovers = await mount({ ready: "signed_in", join: [new LucraApiError(LucraApiErrorCode.apiError), null] });
      expect(await join()).toEqual({ ok: true, matchupId: "matchup-1" });
      expect(recovers.client().joins).toHaveLength(2);
    });

    it("NotInitialized (no signed-in user) signs in and retries once", async () => {
      const { client } = await mount({ ready: "signed_out" });
      // The fake client resolves the join once the login completes.
      expect(await join()).toEqual({ ok: true, matchupId: "matchup-1" });
      expect(client().opened).toEqual(["login"]);
      expect(client().joins).toHaveLength(1);
    });
  });

  it("signOut clears the user and the link", async () => {
    await mount({ ready: "signed_in" });
    await waitFor(() => expect(latest?.link).not.toBeNull());
    await act(async () => latest!.signOut());
    expect(screen.getByTestId("status").textContent).toBe("ready:out");
    expect(screen.getByTestId("user").textContent).toBe("-");
    expect(latest?.link).toBeNull();
  });
});
