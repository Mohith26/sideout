"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { publicEnv, publicLucraCredentials, type PublicLucraMode } from "@/env.public";
import { api } from "@/lib/api-client";
import { API_ERROR_MAX_TRIES, accountFailure, apiErrorBackoffMs, classifySdkFailure, type LucraSdkModule, type LucraUiFailure, type SdkClient, type SdkDialog, type SdkEventMap, type SdkUser } from "@/lucra/sdk-surface";

/**
 * `LucraGate` (spec §7.5, §12.5): the single wrapper that owns the Lucra Web
 * SDK in the browser. It loads the SDK (or, in `LUCRA_MODE=mock`, the
 * stand-in in `src/lucra/sdk-mock.ts`) only on the client, initializes it
 * with the WEB key and tenant id from `env.public.ts` — the BACKEND key is a
 * server value and cannot reach this file (`npm run test:bundle` proves it) —
 * mounts the iframe into its own host element, launches Lucra's flows, and
 * maps every sealed failure to a UI state through `classifySdkFailure`. No
 * other component imports the SDK; ESLint refuses it
 * (`src/lucra/import-boundary.test.ts`). Everything else calls `useLucra()`.
 *
 * The table from §7.5, as this component applies it:
 *
 *   NotInitialized                 gate on `ready`; one automatic re-initialization; `retry()` after that
 *   Unverified                     launch the identity flow, then retry the call once
 *   NotAllowed                     terminal: the failure is surfaced, nothing is retried
 *   InsufficientFunds              launch add funds, then retry once
 *   DemographicInformationMissing  launch the demographic form, then retry once
 *   LocationError                  the location-help state (the grant page first when Lucra has no location), retry
 *   APIError                       three tries with backoff, then surfaced
 *
 * Sign-in binding: on `loginSuccess` (and on a session the SDK restores) the
 * gate mints the link (`POST /api/me/lucra/link`), sends the documented user
 * link to Lucra (`sendMessage.userUpdated({ metadata: { externalId } })`) and
 * asks the server to bind (`POST /api/me/lucra/bind`), which records a Lucra
 * user id only when Lucra's side vouches for it. The SDK's `user.id` travels
 * as a hint the server checks, never as the source.
 *
 * The SDK is initialized with `autoJoin: false`: tournament entry is the
 * explicit `joinTournament` from the registration step, never the silent
 * auto-join the SDK performs by default (§7.5), and the organizer's
 * reconciliation is what proves it.
 */

export type LucraFlow = "auth" | "addFunds" | "withdraw" | "identity" | "demographics" | "rewards" | "wallet" | "profile" | "location";

export type LucraGateStatus =
  /** A live mode with no WEB key or tenant id configured: nothing is loaded and the UI says so. */
  | { kind: "unconfigured" }
  | { kind: "loading" }
  | { kind: "ready"; signedIn: boolean }
  /** Initialization failed even after the one automatic retry; `retry()` tries again. */
  | { kind: "failed"; failure: LucraUiFailure };

export type LaunchOutcome = { ok: true; flow: LucraFlow; completed: boolean } | { ok: false; flow: LucraFlow; failure: LucraUiFailure };
export type JoinOutcome = { ok: true; matchupId: string } | { ok: false; failure: LucraUiFailure };

export interface LucraLinkState {
  externalId: string;
  lucraUserId: string | null;
  verificationState: string;
  bound: boolean;
}

export interface LucraContextValue {
  mode: PublicLucraMode;
  status: LucraGateStatus;
  /** The SDK's signed-in user, or null. Balance and account status come from here; nothing is persisted. */
  user: SdkUser | null;
  /** The last failure a launch or join produced, per the §7.5 table; null after a success or `dismissFailure()`. */
  failure: LucraUiFailure | null;
  /** A flow is on screen or a call is in flight. */
  busy: boolean;
  /** The link as the server reported it after the last sign-in binding. */
  link: LucraLinkState | null;
  launch: (flow: LucraFlow, options?: { matchupId?: string }) => Promise<LaunchOutcome>;
  joinTournament: (matchupId: string) => Promise<JoinOutcome>;
  signOut: () => void;
  /** Re-run initialization after a `failed` status. */
  retry: () => void;
  dismissFailure: () => void;
}

const LucraContext = createContext<LucraContextValue | null>(null);

/** Read the gate. Throws outside a `LucraGate`, which is a programming error, not a state. */
export function useLucra(): LucraContextValue {
  const value = useContext(LucraContext);
  if (!value) throw new Error("useLucra() must be used inside <LucraGate>");
  return value;
}

/** Whether a `LucraGate` is above; components that can render without one check this first. */
export function useLucraOptional(): LucraContextValue | null {
  return useContext(LucraContext);
}

export interface LucraGateProps {
  children: ReactNode;
  /** Test hook: the module to load instead of the real SDK or the stand-in. */
  loadSdk?: () => Promise<LucraSdkModule>;
  /** Test hook: how long the APIError backoff waits; the default is the real schedule. */
  backoffMs?: (attempt: number) => number;
}

async function loadForMode(mode: PublicLucraMode): Promise<LucraSdkModule> {
  // Both are separate chunks; a build only ever loads the one its mode names.
  if (mode === "mock") return import("@/lucra/sdk-mock");
  const real = await import("lucra-web-sdk");
  return real;
}

const HOST_OVERLAY_CSS = "position:fixed;inset:0;z-index:2147483647;display:block;background:var(--bg-inset);";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function LucraGate({ children, loadSdk, backoffMs = apiErrorBackoffMs }: LucraGateProps) {
  const router = useRouter();
  // Server components re-read the rows the receiver changed; the ref keeps the router's identity out of the effect below.
  const routerRef = useRef(router);
  routerRef.current = router;
  const mode = publicEnv.NEXT_PUBLIC_LUCRA_MODE;
  const credentials = useMemo(() => (mode === "mock" ? { apiKey: "mock", tenantId: "sideout-mock" } : publicLucraCredentials(publicEnv)), [mode]);
  const hostRef = useRef<HTMLDivElement>(null);
  const sdkRef = useRef<LucraSdkModule | null>(null);
  const clientRef = useRef<SdkClient | null>(null);
  const boundForRef = useRef<string | null>(null);
  const [status, setStatus] = useState<LucraGateStatus>(credentials ? { kind: "loading" } : { kind: "unconfigured" });
  const [user, setUser] = useState<SdkUser | null>(null);
  const [failure, setFailure] = useState<LucraUiFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<LucraLinkState | null>(null);
  const [generation, setGeneration] = useState(0);

  /**
   * The sign-in binding. Idempotent per Lucra user per mount; the server
   * decides what is recorded.
   */
  const bind = useCallback(
    async (client: SdkClient, signedIn: SdkUser) => {
      const key = signedIn.id ?? "anonymous";
      if (boundForRef.current === key) return;
      boundForRef.current = key;
      const minted = await api<{ externalId: string; lucraUserId: string | null; verificationState: string }>("/api/me/lucra/link", { body: {} });
      if (!minted.ok) {
        boundForRef.current = null;
        return;
      }
      try {
        client.sendMessage.userUpdated({ metadata: { externalId: minted.data.externalId } });
      } catch {
        // The SDK validates metadata shape; ours is a single string, so this cannot fail in practice, and the bind below is the record of truth anyway.
      }
      const bound = await api<LucraLinkState>("/api/me/lucra/bind", { body: { lucraUserId: signedIn.id ?? null } });
      setLink(bound.ok ? bound.data : { externalId: minted.data.externalId, lucraUserId: minted.data.lucraUserId, verificationState: minted.data.verificationState, bound: minted.data.lucraUserId !== null });
      routerRef.current.refresh();
    },
    [],
  );

  useEffect(() => {
    if (!credentials) {
      setStatus({ kind: "unconfigured" });
      return;
    }
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let sdk: LucraSdkModule | null = null;
    const listeners: Array<{ type: keyof SdkEventMap; fn: (data: never) => void }> = [];
    setStatus({ kind: "loading" });

    const initialize = async (attempt: number): Promise<void> => {
      if (!sdk) sdk = await (loadSdk ?? (() => loadForMode(mode)))();
      if (cancelled) return;
      sdkRef.current = sdk;
      // The SDK is a singleton; a previous mount (strict mode, a navigation) is torn down first.
      sdk.LucraClient.destroy();
      const client = sdk.LucraClient.initialize({ apiKey: credentials.apiKey, tenantId: credentials.tenantId, env: mode === "production" ? "production" : "sandbox", autoJoin: false });
      clientRef.current = client;
      const on = <K extends keyof SdkEventMap>(type: K, fn: (data: SdkEventMap[K]) => void) => {
        client.on(type, fn);
        listeners.push({ type, fn: fn as (data: never) => void });
      };
      on("userInfo", (u) => {
        if (!cancelled) setUser(u);
      });
      on("loginSuccess", (u) => {
        if (cancelled) return;
        setUser(u);
        setStatus({ kind: "ready", signedIn: true });
        void bind(client, u);
      });
      // Registering `exitLucra` enables Lucra's own close control; a dialog handles its own close.
      on("exitLucra", () => {
        client.hide();
      });
      client.open(host, undefined, { hidden: true }).home();
      try {
        await client.ready;
        if (cancelled) return;
        const signedIn = client.user;
        setUser(signedIn);
        setStatus({ kind: "ready", signedIn: true });
        if (signedIn) void bind(client, signedIn);
      } catch (err) {
        if (cancelled) return;
        const mapped = classifySdkFailure(err, sdk, client.user);
        if (mapped.kind === "not_initialized" && !mapped.signedIn && client.isInitialized) {
          // Initialized, nobody signed in: the normal signed-out state.
          setStatus({ kind: "ready", signedIn: false });
          return;
        }
        if (mapped.kind === "not_initialized" && attempt < 2) {
          // NotInitialized: gate on ready state, retry (once).
          await initialize(attempt + 1);
          return;
        }
        setStatus({ kind: "failed", failure: mapped });
      }
    };

    void initialize(1).catch((err: unknown) => {
      if (cancelled) return;
      setStatus({ kind: "failed", failure: { kind: "api_error", message: err instanceof Error ? err.message : "The Lucra SDK could not be loaded." } });
    });

    return () => {
      cancelled = true;
      const client = clientRef.current;
      for (const l of listeners) client?.off(l.type, l.fn as never);
      sdk?.LucraClient.destroy();
      clientRef.current = null;
      boundForRef.current = null;
    };
  }, [credentials, mode, loadSdk, bind, generation]);

  /** Wait for one of the SDK's events or the dialog's close, whichever comes first. */
  const awaitDialog = useCallback((client: SdkClient, dialog: SdkDialog, completion: (keyof SdkEventMap)[]): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const handlers: Array<{ type: keyof SdkEventMap; fn: () => void }> = [];
      const finish = (completed: boolean) => {
        if (settled) return;
        settled = true;
        for (const h of handlers) client.off(h.type, h.fn as never);
        resolve(completed);
      };
      for (const type of completion) {
        const fn = () => {
          finish(true);
          dialog.close();
        };
        client.on(type, fn as never);
        handlers.push({ type, fn });
      }
      dialog.onClose(() => finish(false));
    });
  }, []);

  /** The sign-in flow: Lucra's own login screen, awaited until `loginSuccess` or the user leaves it. */
  const runAuth = useCallback(
    (client: SdkClient): Promise<boolean> => {
      const host = hostRef.current;
      if (!host) return Promise.resolve(false);
      if (client.user) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const previousCss = host.style.cssText;
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          client.off("loginSuccess", onLogin);
          client.off("exitLucra", onExit);
          document.removeEventListener("keydown", onKey);
          host.style.cssText = previousCss;
          client.hide();
          resolve(ok);
        };
        const onLogin = () => finish(true);
        const onExit = () => finish(false);
        const onKey = (e: KeyboardEvent) => {
          if (e.key === "Escape") finish(false);
        };
        client.on("loginSuccess", onLogin);
        client.on("exitLucra", onExit);
        document.addEventListener("keydown", onKey);
        host.style.cssText = HOST_OVERLAY_CSS;
        client.open(host).login();
        client.show();
      });
    },
    [],
  );

  const launch = useCallback(
    async (flow: LucraFlow, options: { matchupId?: string } = {}): Promise<LaunchOutcome> => {
      const client = clientRef.current;
      const sdk = sdkRef.current;
      if (!client || !sdk || status.kind === "loading" || status.kind === "unconfigured") {
        const f: LucraUiFailure = status.kind === "unconfigured" ? { kind: "api_error", message: "Lucra is not configured for this deployment." } : { kind: "not_initialized", signedIn: false };
        setFailure(f);
        return { ok: false, flow, failure: f };
      }
      const blocked = accountFailure(client.user);
      if (blocked && flow !== "auth" && flow !== "profile") {
        setFailure(blocked);
        return { ok: false, flow, failure: blocked };
      }
      setBusy(true);
      setFailure(null);
      try {
        if (flow === "auth") {
          const ok = await runAuth(client);
          if (!ok) {
            const f: LucraUiFailure = { kind: "not_initialized", signedIn: false };
            setFailure(f);
            return { ok: false, flow, failure: f };
          }
          return { ok: true, flow, completed: true };
        }
        if (!client.user) {
          // Every other flow is user-scoped: sign in first, then continue.
          const ok = await runAuth(client);
          if (!ok) {
            const f: LucraUiFailure = { kind: "not_initialized", signedIn: false };
            setFailure(f);
            return { ok: false, flow, failure: f };
          }
        }
        const nav = client.dialog();
        let completed: boolean;
        switch (flow) {
          case "identity":
            completed = await awaitDialog(client, nav.kyc(), ["kycComplete"]);
            break;
          case "demographics":
            completed = await awaitDialog(client, nav.demographic(), ["demographicComplete"]);
            break;
          case "location":
            completed = await awaitDialog(client, nav.locationGrant(), ["locationGranted"]);
            break;
          case "addFunds":
            completed = await awaitDialog(client, nav.deposit(), []);
            completed = true;
            break;
          case "withdraw":
            await awaitDialog(client, nav.withdraw(), []);
            completed = true;
            break;
          case "wallet":
            await awaitDialog(client, nav.wallet(), []);
            completed = true;
            break;
          case "profile":
            await awaitDialog(client, nav.profile(), []);
            completed = true;
            break;
          case "rewards":
            // v1.12.0 has no dedicated rewards route: earned rewards live on the tournament's detail, and the profile otherwise.
            await awaitDialog(client, options.matchupId ? nav.tournamentDetails(options.matchupId) : nav.profile(), []);
            completed = true;
            break;
          default:
            completed = false;
        }
        if (flow === "identity" || flow === "demographics") routerRef.current.refresh();
        return { ok: true, flow, completed };
      } catch (err) {
        const mapped = classifySdkFailure(err, sdk, client.user);
        setFailure(mapped);
        return { ok: false, flow, failure: mapped };
      } finally {
        setBusy(false);
      }
    },
    [awaitDialog, runAuth, status.kind],
  );

  const joinTournament = useCallback(
    async (matchupId: string): Promise<JoinOutcome> => {
      const client = clientRef.current;
      const sdk = sdkRef.current;
      if (!client || !sdk || status.kind !== "ready") {
        const f: LucraUiFailure = status.kind === "unconfigured" ? { kind: "api_error", message: "Lucra is not configured for this deployment." } : { kind: "not_initialized", signedIn: false };
        setFailure(f);
        return { ok: false, failure: f };
      }
      setBusy(true);
      setFailure(null);
      // Each remediation from the table is applied once; APIError gets its backoff schedule.
      const remedied = new Set<LucraUiFailure["kind"]>();
      let apiTries = 0;
      try {
        for (;;) {
          const preflight = accountFailure(client.user);
          if (preflight) {
            setFailure(preflight);
            return { ok: false, failure: preflight };
          }
          try {
            const { matchupId: joined } = await client.api.joinTournament(matchupId);
            setFailure(null);
            routerRef.current.refresh();
            return { ok: true, matchupId: joined };
          } catch (err) {
            const mapped = classifySdkFailure(err, sdk, client.user);
            let recovered = false;
            switch (mapped.kind) {
              case "not_initialized":
                if (!remedied.has("not_initialized")) {
                  remedied.add("not_initialized");
                  recovered = mapped.signedIn ? true : await runAuth(client);
                }
                break;
              case "unverified":
                if (!remedied.has("unverified")) {
                  remedied.add("unverified");
                  setBusy(false);
                  recovered = (await launch("identity")).ok && client.user !== null;
                  setBusy(true);
                }
                break;
              case "insufficient_funds":
                if (!remedied.has("insufficient_funds")) {
                  remedied.add("insufficient_funds");
                  setBusy(false);
                  recovered = (await launch("addFunds")).ok;
                  setBusy(true);
                }
                break;
              case "demographics_missing":
                if (!remedied.has("demographics_missing")) {
                  remedied.add("demographics_missing");
                  setBusy(false);
                  const out = await launch("demographics");
                  setBusy(true);
                  recovered = out.ok && out.completed;
                }
                break;
              case "location":
                if (mapped.grant && !remedied.has("location")) {
                  remedied.add("location");
                  setBusy(false);
                  const out = await launch("location");
                  setBusy(true);
                  recovered = out.ok && out.completed;
                }
                break;
              case "api_error":
                apiTries += 1;
                if (apiTries < API_ERROR_MAX_TRIES) {
                  await sleep(backoffMs(apiTries));
                  recovered = true;
                }
                break;
              case "not_allowed":
                recovered = false;
                break;
            }
            if (!recovered) {
              setFailure(mapped);
              return { ok: false, failure: mapped };
            }
          }
        }
      } finally {
        setBusy(false);
      }
    },
    [backoffMs, launch, runAuth, status.kind],
  );

  const signOut = useCallback(() => {
    const client = clientRef.current;
    if (!client) return;
    client.logout();
    setUser(null);
    setLink(null);
    boundForRef.current = null;
    setStatus({ kind: "ready", signedIn: false });
    routerRef.current.refresh();
  }, []);

  const retry = useCallback(() => {
    setFailure(null);
    setGeneration((g) => g + 1);
  }, []);

  const dismissFailure = useCallback(() => setFailure(null), []);

  const value = useMemo<LucraContextValue>(
    () => ({ mode, status, user, failure, busy, link, launch, joinTournament, signOut, retry, dismissFailure }),
    [mode, status, user, failure, busy, link, launch, joinTournament, signOut, retry, dismissFailure],
  );

  return (
    <LucraContext.Provider value={value}>
      {children}
      {/* The SDK's host: the iframe (or the stand-in's sheet) mounts here; a dialog styles it as a fullscreen overlay. */}
      <div ref={hostRef} data-lucra-host="" data-lucra-mode={mode} />
    </LucraContext.Provider>
  );
}
