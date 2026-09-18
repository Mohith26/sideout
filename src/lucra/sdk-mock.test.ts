// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LucraApiError, LucraApiErrorCode, LucraClient, LucraUserNotLoggedIn, MOCK_LOCATION_KEY, MOCK_SDK_PATH, MOCK_SESSION_KEY, type MockSdkAction } from "@/lucra/sdk-mock";

/**
 * The browser stand-in behaves like the SDK it replaces: a singleton with the
 * same lifecycle, `ready` that rejects with the not-logged-in class until a
 * sign-in, sheets that resolve against `POST /api/rest/_mock/sdk` and emit
 * the SDK's completion events, and `api.joinTournament` that rejects with
 * the SDK's own codes. The server side is a scripted fetch here; its real
 * behaviour is covered by `src/app/api/lucra-sdk.test.ts`.
 */

type Handler = (action: MockSdkAction) => { status?: number; body: unknown };

const calls: MockSdkAction[] = [];
let handler: Handler = () => ({ body: {} });
const user = { id: "lucra-1", username: "ana", balance: 0, accountStatus: "UNVERIFIED", metadata: {} };

function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

function sheet(): HTMLElement | null {
  return document.querySelector("[data-lucra-mock-sheet]");
}

function press(action: string) {
  const b = document.querySelector<HTMLButtonElement>(`[data-lucra-mock-action="${action}"]`);
  if (!b) throw new Error(`no button ${action}; sheet is ${sheet()?.getAttribute("data-lucra-mock-sheet") ?? "absent"}`);
  b.click();
}

describe("Lucra SDK stand-in", () => {
  let host: HTMLDivElement;
  beforeEach(() => {
    calls.length = 0;
    localStorage.clear();
    host = document.createElement("div");
    document.body.append(host);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (!url.endsWith(MOCK_SDK_PATH)) throw new Error(`unexpected fetch ${url}`);
        const action = JSON.parse(String(init?.body)) as MockSdkAction;
        calls.push(action);
        const { status = 200, body } = handler(action);
        const envelope = status >= 400 ? { ok: false, error: body } : { ok: true, data: body };
        return new Response(JSON.stringify(envelope), { status, headers: { "content-type": "application/json" } });
      }),
    );
    handler = (action) => {
      switch (action.action) {
        case "session":
          return { body: { action: "session", user: localStorage.getItem(MOCK_SESSION_KEY) ? user : null } };
        case "login":
          return { body: { action: "login", user } };
        case "kyc":
          return { body: { action: "kyc", outcome: "verified", user: { ...user, accountStatus: "VERIFIED" } } };
        case "join":
          return { body: { action: "join", matchupId: action.matchupId } };
        default:
          return { body: { action: action.action, user } };
      }
    };
  });
  afterEach(() => {
    LucraClient.destroy();
    host.remove();
    vi.unstubAllGlobals();
  });

  it("is a singleton with the SDK's lifecycle and refuses half a credential pair", () => {
    expect(() => LucraClient.getInstance()).toThrow(/not been initialized/);
    expect(() => LucraClient.initialize({ apiKey: "", tenantId: "t", env: "sandbox" })).toThrow(/apiKey and tenantId/);
    const client = LucraClient.initialize({ apiKey: "k", tenantId: "t", env: "sandbox", autoJoin: false });
    expect(() => LucraClient.initialize({ apiKey: "k", tenantId: "t", env: "sandbox" })).toThrow(/already initialized/);
    expect(LucraClient.getInstance()).toBe(client);
    expect(client.isInitialized).toBe(false);
    LucraClient.destroy();
    expect(() => LucraClient.getInstance()).toThrow();
  });

  it("initializes signed out, rejects ready with LucraUserNotLoggedIn, and signs in through the login sheet", async () => {
    const client = LucraClient.initialize({ apiKey: "k", tenantId: "t", env: "sandbox" });
    const events: string[] = [];
    client.on("initialized", ({ success }) => events.push(`initialized:${success}`));
    client.on("loginSuccess", (u) => events.push(`login:${u.id}`));
    client.on("userInfo", (u) => events.push(`user:${u.accountStatus}`));
    client.open(host, undefined, { hidden: true }).home();
    await flush();
    expect(client.isInitialized).toBe(true);
    await expect(client.ready).rejects.toBeInstanceOf(LucraUserNotLoggedIn);
    expect(calls).toEqual([]); // no session flag, no session read
    expect(events).toEqual(["initialized:true"]);

    client.dialog(); // reachable once open
    client.open(host).login();
    expect(sheet()?.getAttribute("data-lucra-mock-sheet")).toBe("login");
    expect(sheet()?.getAttribute("role")).toBe("dialog");
    press("login");
    await flush();
    await flush();
    expect(sheet()).toBeNull();
    expect(client.user).toEqual(user);
    expect(localStorage.getItem(MOCK_SESSION_KEY)).toBe("1");
    await expect(client.ready).resolves.toBeUndefined();
    expect(events).toEqual(["initialized:true", "user:UNVERIFIED", "login:lucra-1"]);
    // The host's inline styles were restored when the sheet closed.
    expect(host.style.cssText).toBe("");
  });

  it("restores a browser-held session on the next load and clears it on logout", async () => {
    localStorage.setItem(MOCK_SESSION_KEY, "1");
    const client = LucraClient.initialize({ apiKey: "k", tenantId: "t", env: "sandbox" });
    client.open(host, undefined, { hidden: true }).home();
    await flush();
    await flush();
    expect(calls.map((c) => c.action)).toEqual(["session"]);
    await expect(client.ready).resolves.toBeUndefined();
    expect(client.user?.id).toBe("lucra-1");
    client.logout();
    expect(localStorage.getItem(MOCK_SESSION_KEY)).toBeNull();
    expect(client.user).toBeNull();
    await expect(client.ready).rejects.toBeInstanceOf(LucraUserNotLoggedIn);
  });

  it("the identity sheet resolves against the server, emits kycComplete, and Escape closes any sheet", async () => {
    localStorage.setItem(MOCK_SESSION_KEY, "1");
    const client = LucraClient.initialize({ apiKey: "k", tenantId: "t", env: "sandbox" });
    client.open(host, undefined, { hidden: true }).home();
    await flush();
    await flush();
    const events: string[] = [];
    client.on("kycComplete", () => events.push("kycComplete"));
    client.on("demographicComplete", () => events.push("demographicComplete"));
    let closed = 0;
    const dialog = client.dialog().kyc();
    dialog.onClose(() => (closed += 1));
    expect(sheet()?.getAttribute("data-lucra-mock-sheet")).toBe("kyc");
    press("kyc");
    await flush();
    await flush();
    expect(events).toEqual(["kycComplete"]);
    expect(closed).toBe(1);
    expect(client.user?.accountStatus).toBe("VERIFIED");
    dialog.close(); // idempotent
    expect(closed).toBe(1);

    // A blocked account: the sheet turns terminal and fires nothing.
    handler = (a) => (a.action === "kyc" ? { body: { action: "kyc", outcome: "not_allowed", user: { ...user, accountStatus: "BLOCKED" } } } : { body: { action: a.action, user } });
    client.dialog().kyc();
    press("kyc");
    await flush();
    await flush();
    expect(sheet()?.getAttribute("data-lucra-mock-sheet")).toBe("kyc-not-allowed");
    expect(events).toEqual(["kycComplete"]);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(sheet()).toBeNull();

    // Demographics required first: the same sheet continues into the form and then reports both completions.
    handler = (a) => (a.action === "kyc" ? { body: { action: "kyc", outcome: "demographics_required", user } } : a.action === "demographic" ? { body: { action: "demographic", user: { ...user, accountStatus: "AGE_ASSURED_VERIFIED" } } } : { body: { action: a.action, user } });
    client.dialog().kyc();
    press("kyc");
    await flush();
    await flush();
    expect(sheet()?.getAttribute("data-lucra-mock-sheet")).toBe("demographic");
    press("demographic");
    await flush();
    await flush();
    expect(events).toEqual(["kycComplete", "demographicComplete", "kycComplete"]);
    expect(sheet()).toBeNull();
  });

  it("joinTournament applies the SDK's gates with the SDK's classes, and the location grant unblocks it", async () => {
    const client = LucraClient.initialize({ apiKey: "k", tenantId: "t", env: "sandbox" });
    client.open(host, undefined, { hidden: true }).home();
    await flush();
    await expect(client.api.joinTournament("m-1")).rejects.toBeInstanceOf(LucraUserNotLoggedIn);
    localStorage.setItem(MOCK_SESSION_KEY, "1");
    LucraClient.destroy();
    const signedIn = LucraClient.initialize({ apiKey: "k", tenantId: "t", env: "sandbox" });
    signedIn.open(host, undefined, { hidden: true }).home();
    await flush();
    await flush();
    const needsLocation = await signedIn.api.joinTournament("m-1").catch((e: unknown) => e);
    expect(needsLocation).toBeInstanceOf(LucraApiError);
    expect((needsLocation as LucraApiError).code).toBe(LucraApiErrorCode.locationNeeded);
    const granted: string[] = [];
    signedIn.on("locationGranted", () => granted.push("granted"));
    signedIn.dialog().locationGrant();
    press("location-grant");
    expect(granted).toEqual(["granted"]);
    expect(localStorage.getItem(MOCK_LOCATION_KEY)).toBe("granted");
    const joined: string[] = [];
    signedIn.on("tournamentJoined", ({ matchupId }) => joined.push(matchupId));
    await expect(signedIn.api.joinTournament("m-1")).resolves.toEqual({ matchupId: "m-1" });
    expect(joined).toEqual(["m-1"]);
    // A refusal carrying one of the SDK's codes becomes that code; an unknown one is the catch-all.
    handler = () => ({ status: 409, body: { code: "conflict", message: "form first", detail: { code: "DEMOGRAPHIC_INFORMATION_MISSING" } } });
    const refused = await signedIn.api.joinTournament("m-1").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(LucraApiError);
    expect((refused as LucraApiError).code).toBe(LucraApiErrorCode.demographicInformationMissing);
    expect((refused as LucraApiError).message).toBe("form first");
    handler = () => ({ status: 409, body: { code: "conflict", message: "nope" } });
    expect(((await signedIn.api.joinTournament("m-1").catch((e: unknown) => e)) as LucraApiError).code).toBe(LucraApiErrorCode.apiError);
    handler = () => ({ status: 401, body: { code: "unauthorized", message: "sign in" } });
    await expect(signedIn.api.joinTournament("m-1")).rejects.toBeInstanceOf(LucraUserNotLoggedIn);
  });

  it("userUpdated posts the metadata (the documented user link) and the wallet sheets move the balance", async () => {
    localStorage.setItem(MOCK_SESSION_KEY, "1");
    const client = LucraClient.initialize({ apiKey: "k", tenantId: "t", env: "sandbox" });
    client.open(host, undefined, { hidden: true }).home();
    await flush();
    await flush();
    client.sendMessage.userUpdated({ metadata: { externalId: "ext-1" } });
    await flush();
    expect(calls.at(-1)).toEqual({ action: "userUpdated", metadata: { externalId: "ext-1" } });
    handler = (a) => (a.action === "deposit" ? { body: { action: "deposit", user: { ...user, balance: a.amountCents / 100 } } } : { body: { action: a.action, user } });
    client.dialog().deposit();
    expect(sheet()?.getAttribute("data-lucra-mock-sheet")).toBe("deposit");
    press("deposit-2500");
    await flush();
    await flush();
    expect(client.user?.balance).toBe(25);
    expect(sheet()).toBeNull();
    handler = () => ({ status: 409, body: { code: "conflict", message: "short", detail: { code: "INSUFFICIENT_FUNDS" } } });
    client.dialog().withdraw();
    press("withdraw-5000");
    await flush();
    await flush();
    expect(sheet()?.getAttribute("data-lucra-mock-sheet")).toBe("withdraw-error");
    expect(sheet()?.textContent).toContain("short");
  });
});
