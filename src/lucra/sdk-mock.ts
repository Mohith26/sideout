import type { SdkClient, SdkClientConfig, SdkDialog, SdkDialogNavigation, SdkEventMap, SdkOpenNavigation, SdkUser } from "@/lucra/sdk-surface";

/**
 * The browser stand-in for `lucra-web-sdk` in `LUCRA_MODE=mock` (spec §7.1:
 * the app is fully demoable with only mock mode set, and §7.5's flows are
 * Lucra's own UI, which no credentials can reach here).
 *
 * Same surface as the real package (`LucraClient.initialize` / `getInstance`
 * / `destroy`, `ready`, `isInitialized`, `user`, `open(host).home()` /
 * `.login()`, `dialog().<route>()` returning a `LucraDialog`, `on` / `off`,
 * `api.joinTournament`, `sendMessage.userUpdated`) and the same sealed error
 * classes (`LucraUserNotLoggedIn`, `LucraApiError` with `LucraApiErrorCode`),
 * so `LucraGate` branches on exactly what it would branch on in sandbox.
 *
 * Where the real SDK mounts Lucra's iframe, this mounts a small sheet on the
 * design tokens into the same host element and resolves each flow against
 * the server-side mock through `POST /api/rest/_mock/sdk` (`route.mock.ts`,
 * absent from any non-mock build). Outcomes are deterministic per seeded
 * account: the seeded `not_allowed` player is `BLOCKED` in the mock and the
 * `demographics_missing` player needs the demographic form before anything
 * else, so those states are visible without contriving them (§13). Every
 * state change goes through the same path production takes — the mock emits
 * its signed webhooks (`UserSignedUp`, `UserKYCVerified`,
 * `TournamentUserJoined`) and the app's receiver updates the row — so the
 * profile and the organizer's reconciliation read what the database says,
 * never what the browser claims.
 *
 * Like the iframe's own cookie, the mock session lives in the browser
 * (`localStorage`), as does the location grant; the server never trusts
 * either for anything but this stand-in.
 */

// ---------------------------------------------------------------------------
// The sealed error surface, values identical to the SDK's
// ---------------------------------------------------------------------------

export enum LucraApiErrorCode {
  unverified = "UNVERIFIED",
  insufficientFunds = "INSUFFICIENT_FUNDS",
  demographicInformationMissing = "DEMOGRAPHIC_INFORMATION_MISSING",
  locationError = "LOCATION_ERROR",
  locationNeeded = "LOCATION_NEEDED",
  apiError = "API_ERROR",
}

export class LucraUserNotLoggedIn extends Error {
  constructor(message = "Lucra user is not logged in") {
    super(message);
    this.name = "LucraUserNotLoggedIn";
    Object.setPrototypeOf(this, LucraUserNotLoggedIn.prototype);
  }
}

const API_ERROR_MESSAGES: Record<LucraApiErrorCode, string> = {
  [LucraApiErrorCode.unverified]: "User is not verified",
  [LucraApiErrorCode.insufficientFunds]: "User has insufficient funds",
  [LucraApiErrorCode.demographicInformationMissing]: "Required demographic information is missing",
  [LucraApiErrorCode.locationError]: "User location could not be verified",
  [LucraApiErrorCode.locationNeeded]: "User location has not been granted",
  [LucraApiErrorCode.apiError]: "The request could not be completed",
};

export class LucraApiError extends Error {
  readonly code: LucraApiErrorCode;
  constructor(code: LucraApiErrorCode, message?: string) {
    super(message ?? API_ERROR_MESSAGES[code] ?? code);
    this.name = "LucraApiError";
    this.code = code;
    Object.setPrototypeOf(this, LucraApiError.prototype);
  }
}

// ---------------------------------------------------------------------------
// The server-side mock's SDK surface (see src/server/lucra-sdk-mock.ts)
// ---------------------------------------------------------------------------

export const MOCK_SDK_PATH = "/api/rest/_mock/sdk";
export const MOCK_SESSION_KEY = "sideout.lucra-mock.signed-in";
export const MOCK_LOCATION_KEY = "sideout.lucra-mock.location";

export type MockSdkAction =
  | { action: "session" }
  | { action: "login" }
  | { action: "logout" }
  | { action: "userUpdated"; metadata: Record<string, string> | null }
  | { action: "kyc" }
  | { action: "demographic" }
  | { action: "deposit"; amountCents: number }
  | { action: "withdraw"; amountCents: number }
  | { action: "join"; matchupId: string }
  | { action: "tournament"; matchupId: string };

export interface MockTournamentView {
  matchupId: string;
  title: string;
  status: string;
  participants: number;
  buyInCents: number;
  rewards: Array<{ position: number; value: number; userName: string | null }>;
  you: { score: number | null; position: number | null; attemptFinished: boolean } | null;
}

export type MockSdkResult =
  | { action: "session"; user: SdkUser | null }
  | { action: "login"; user: SdkUser }
  | { action: "logout" }
  | { action: "userUpdated"; user: SdkUser }
  | { action: "kyc"; outcome: "verified" | "not_allowed" | "demographics_required"; user: SdkUser }
  | { action: "demographic"; user: SdkUser }
  | { action: "deposit"; user: SdkUser }
  | { action: "withdraw"; user: SdkUser }
  | { action: "join"; matchupId: string }
  | { action: "tournament"; tournament: MockTournamentView };

type Envelope = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string; detail?: { code?: string } } };

/** A refusal from the mock backend carrying one of the SDK's codes becomes the SDK's error. */
async function callMock<A extends MockSdkAction>(body: A): Promise<Extract<MockSdkResult, { action: A["action"] }>> {
  let response: Response;
  try {
    response = await fetch(MOCK_SDK_PATH, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new LucraApiError(LucraApiErrorCode.apiError, "Could not reach the Lucra mock.");
  }
  let parsed: Envelope | null = null;
  try {
    parsed = (await response.json()) as Envelope;
  } catch {
    parsed = null;
  }
  if (!parsed) throw new LucraApiError(LucraApiErrorCode.apiError, `The Lucra mock answered ${response.status}.`);
  if (!parsed.ok) {
    if (response.status === 401) throw new LucraUserNotLoggedIn();
    const code = parsed.error.detail?.code;
    const known = (Object.values(LucraApiErrorCode) as string[]).includes(code ?? "") ? (code as LucraApiErrorCode) : LucraApiErrorCode.apiError;
    throw new LucraApiError(known, parsed.error.message);
  }
  return parsed.data as Extract<MockSdkResult, { action: A["action"] }>;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The sheet: a small overlay on the design tokens, in the host element
// ---------------------------------------------------------------------------

const HOST_CSS = "position:fixed;inset:0;z-index:2147483647;display:block;";

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "style") node.style.cssText = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

const TEXT = "color:var(--text-primary);font:inherit;font-size:var(--fs-body);line-height:var(--lh-body);";
const MUTED = "color:var(--text-secondary);font-size:var(--fs-body);line-height:var(--lh-body);margin:0;";
const LABEL = "color:var(--text-tertiary);font-size:var(--fs-label);letter-spacing:var(--tracking-label);text-transform:uppercase;font-weight:500;font-variant-numeric:tabular-nums;";
const BUTTON = "display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:0 16px;border-radius:var(--r-sm);font:inherit;font-size:var(--fs-body);font-weight:500;cursor:pointer;white-space:nowrap;";
const PRIMARY = `${BUTTON}background:var(--volt);color:var(--on-volt);border:1px solid var(--volt);`;
const SECONDARY = `${BUTTON}background:var(--bg-raised);color:var(--text-primary);border:1px solid var(--border-subtle);`;
const GHOST = `${BUTTON}background:transparent;color:var(--text-secondary);border:1px solid transparent;`;

function button(label: string, style: string, onClick: () => void, attrs: Record<string, string> = {}): HTMLButtonElement {
  const b = h("button", { type: "button", style, ...attrs }, label);
  b.addEventListener("click", onClick);
  return b;
}

interface SheetSpec {
  /** A stable name for tests and screenshots (`data-lucra-mock-sheet`). */
  name: string;
  title: string;
  body: Child[];
  actions: HTMLElement[];
}

/**
 * Presents the host as a fullscreen overlay with a bottom sheet (a centred
 * card from 768px), mirroring the real SDK's `createDialog`: Escape and the
 * close control dismiss it, `onClose` fires once, `close()` is idempotent,
 * and the host's inline styles are restored afterwards. The backdrop is the
 * one place backdrop blur is allowed (§14).
 */
function presentSheet(host: HTMLElement, spec: SheetSpec, onDismiss: () => void): SdkDialog & { render: (next: SheetSpec) => void } {
  const previousCss = host.style.cssText;
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  host.style.cssText = HOST_CSS;
  const wide = typeof window.matchMedia === "function" ? window.matchMedia("(min-width: 768px)").matches : false;
  const backdrop = h("div", { "data-lucra-mock-backdrop": "", style: "position:absolute;inset:0;background:rgb(5 6 7 / 0.6);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);" });
  const panel = h("div", {
    role: "dialog",
    "aria-modal": "true",
    "data-lucra-mock-sheet": spec.name,
    style: `position:absolute;${wide ? "left:50%;top:50%;transform:translate(-50%,-50%);width:min(100vw - 32px, 28rem);border-radius:var(--r-lg);" : "left:0;right:0;bottom:0;border-radius:var(--r-lg) var(--r-lg) 0 0;padding-bottom:env(safe-area-inset-bottom, 0px);"}background:var(--bg-overlay);border:1px solid var(--border-strong);${TEXT}animation:sheet-in var(--d-enter) var(--ease-out-expo) both;`,
  });
  host.append(backdrop, panel);

  const controller = new AbortController();
  const onCloseCallbacks = new Set<() => void>();
  let closed = false;
  const dialog = {
    close: () => {
      if (closed) return;
      closed = true;
      controller.abort();
      backdrop.remove();
      panel.remove();
      host.style.cssText = previousCss;
      onDismiss();
      onCloseCallbacks.forEach((cb) => cb());
      onCloseCallbacks.clear();
      previouslyFocused?.focus();
    },
    onClose: (cb: () => void) => {
      onCloseCallbacks.add(cb);
    },
    render: (next: SheetSpec) => {
      panel.replaceChildren();
      panel.setAttribute("data-lucra-mock-sheet", next.name);
      const titleId = `lucra-mock-title-${next.name}`;
      panel.setAttribute("aria-labelledby", titleId);
      const close = button("Close", GHOST, () => dialog.close(), { "aria-label": "Close Lucra" });
      panel.append(
        h(
          "div",
          { style: "display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px 0;" },
          h("p", { style: `${LABEL}margin:0;` }, "Lucra · mock stand-in"),
          close,
        ),
        h("h2", { id: titleId, style: "margin:8px 20px 0;font-size:var(--fs-subheading);font-weight:600;line-height:1.3;" }, next.title),
        h("div", { style: "display:grid;gap:12px;padding:12px 20px 0;" }, ...next.body),
        h("div", { style: "display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;padding:20px;" }, ...next.actions),
      );
      const first = next.actions.find((a) => a instanceof HTMLButtonElement && !a.disabled) ?? close;
      first.focus();
    },
  };
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") dialog.close();
    },
    { signal: controller.signal },
  );
  backdrop.addEventListener("click", () => dialog.close(), { signal: controller.signal });
  dialog.render(spec);
  return dialog;
}

function note(text: string): HTMLElement {
  return h("p", { style: MUTED }, text);
}

function fact(label: string, value: string): HTMLElement {
  return h("div", { style: "display:flex;justify-content:space-between;gap:12px;border-top:1px solid var(--border-subtle);padding-top:8px;" }, h("span", { style: LABEL }, label), h("span", { style: "font-variant-numeric:tabular-nums;" }, value));
}

function dollars(user: SdkUser | null): string {
  const balance = user?.balance ?? 0;
  return `$${balance.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

type Listener<K extends keyof SdkEventMap> = (data: SdkEventMap[K]) => void;

export class LucraClient implements SdkClient {
  private static instance: LucraClient | null = null;

  readonly config: SdkClientConfig;
  private listeners = new Map<keyof SdkEventMap, Set<Listener<keyof SdkEventMap>>>();
  private host: HTMLElement | null = null;
  private frame: HTMLElement | null = null;
  private _user: SdkUser | null = null;
  private _isInitialized = false;
  private _ready: Promise<void> = Promise.reject(new LucraUserNotLoggedIn());
  private activeDialog: (SdkDialog & { render: (next: SheetSpec) => void }) | null = null;

  private constructor(config: SdkClientConfig) {
    if (!config.apiKey || !config.tenantId) throw new Error("Both apiKey and tenantId must be provided to create LucraClient");
    this.config = config;
    this._ready.catch(() => {});
  }

  static initialize(config: SdkClientConfig): LucraClient {
    if (LucraClient.instance) throw new Error("LucraClient is already initialized. Call LucraClient.getInstance() to retrieve the existing instance.");
    LucraClient.instance = new LucraClient(config);
    return LucraClient.instance;
  }

  static getInstance(): LucraClient {
    if (!LucraClient.instance) throw new Error("LucraClient has not been initialized. Call LucraClient.initialize(config) first.");
    return LucraClient.instance;
  }

  static destroy(): void {
    const instance = LucraClient.instance;
    if (!instance) return;
    instance.activeDialog?.close();
    instance.frame?.remove();
    instance.frame = null;
    instance.host = null;
    instance.listeners.clear();
    instance._user = null;
    instance._isInitialized = false;
    LucraClient.instance = null;
  }

  get ready(): Promise<void> {
    return this._ready;
  }

  get isInitialized(): boolean {
    return this._isInitialized;
  }

  get user(): SdkUser | null {
    return this._user;
  }

  // -- events -----------------------------------------------------------------

  on<K extends keyof SdkEventMap>(type: K, listener: Listener<K>): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener as Listener<keyof SdkEventMap>);
    if (type === "userInfo" && this._user) (listener as Listener<"userInfo">)(this._user);
  }

  off<K extends keyof SdkEventMap>(type: K, listener: Listener<K>): void {
    this.listeners.get(type)?.delete(listener as Listener<keyof SdkEventMap>);
  }

  private emit<K extends keyof SdkEventMap>(type: K, data: SdkEventMap[K]): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) (listener as Listener<K>)(data);
  }

  // -- mounting -----------------------------------------------------------------

  /** Mounts the stand-in "frame" into `element` and runs the initialization the iframe would. */
  open(element: HTMLElement, _phoneNumber?: string, options?: { hidden?: boolean }): SdkOpenNavigation {
    const mount = () => {
      if (!this.frame) {
        this.host = element;
        this.frame = h("div", { "data-lucra-mock-frame": "", style: "display:none;" });
        element.append(this.frame);
        if (options?.hidden === false) this.show();
        void this.initialize();
      }
      return this;
    };
    return {
      home: () => mount(),
      login: () => {
        mount();
        this.presentLogin();
        return this;
      },
    };
  }

  private setUser(user: SdkUser | null): void {
    this._user = user;
    if (user) this.emit("userInfo", user);
  }

  /** Read the browser-held session back the way the iframe would on load. */
  private async initialize(): Promise<void> {
    this._isInitialized = true;
    const signedIn = storage()?.getItem(MOCK_SESSION_KEY) === "1";
    let user: SdkUser | null = null;
    if (signedIn) {
      try {
        user = (await callMock({ action: "session" })).user;
      } catch {
        user = null;
      }
    }
    this.setUser(user);
    this._ready = user ? Promise.resolve() : Promise.reject(new LucraUserNotLoggedIn());
    this._ready.catch(() => {});
    this.emit("initialized", { success: true });
    if (user) this.emit("loginSuccess", user);
  }

  hide(): this {
    if (this.frame) this.frame.style.display = "none";
    return this;
  }

  show(): this {
    if (this.frame) this.frame.style.display = "block";
    return this;
  }

  logout(): this {
    storage()?.removeItem(MOCK_SESSION_KEY);
    this._user = null;
    this._ready = Promise.reject(new LucraUserNotLoggedIn());
    this._ready.catch(() => {});
    void callMock({ action: "logout" }).catch(() => undefined);
    return this;
  }

  // -- flows --------------------------------------------------------------------

  private requireHost(): HTMLElement {
    if (!this.host || !this.frame) throw new Error("Cannot open a dialog. LucraClient is not open.");
    return this.host;
  }

  private present(spec: SheetSpec): SdkDialog & { render: (next: SheetSpec) => void } {
    const host = this.requireHost();
    this.activeDialog?.close();
    this.show();
    const dialog = presentSheet(host, spec, () => this.hide());
    dialog.onClose(() => {
      if (this.activeDialog === dialog) this.activeDialog = null;
    });
    this.activeDialog = dialog;
    return dialog;
  }

  private presentLogin(): SdkDialog {
    let busy = false;
    const dialog = this.present({
      name: "login",
      title: "Sign in to Lucra",
      body: [note("In sandbox and production this is Lucra's own phone sign-in inside its iframe. The mock signs you in as the Sideout account you are using, with the phone number on it."), h("p", { style: `${LABEL}margin:0;` }, "No code is sent")],
      actions: [
        button(
          "Continue with this phone",
          PRIMARY,
          async () => {
            if (busy) return;
            busy = true;
            try {
              const { user } = await callMock({ action: "login" });
              storage()?.setItem(MOCK_SESSION_KEY, "1");
              // Close first so the host's styles are restored before anyone reacts to the sign-in.
              dialog.close();
              this.setUser(user);
              this._ready = Promise.resolve();
              this.emit("loginSuccess", user);
            } catch (err) {
              busy = false;
              dialog.render({ name: "login", title: "Sign in to Lucra", body: [note(err instanceof Error ? err.message : "Sign-in failed.")], actions: [button("Close", SECONDARY, () => dialog.close())] });
            }
          },
          { "data-lucra-mock-action": "login" },
        ),
      ],
    });
    return dialog;
  }

  private presentKyc(): SdkDialog {
    const dialog = this.present({
      name: "kyc",
      title: "Verify your identity",
      body: [note("Lucra's identity form asks for your legal name, date of birth and address to confirm you are old enough and somewhere Lucra operates. Sideout never sees or stores any of it; only the outcome comes back."), note("The mock resolves it from the seeded account.")],
      actions: [
        button(
          "Complete verification",
          PRIMARY,
          async () => {
            try {
              const { outcome, user } = await callMock({ action: "kyc" });
              this.setUser(user);
              if (outcome === "verified") {
                this.emit("kycComplete", undefined);
                dialog.close();
              } else if (outcome === "demographics_required") {
                dialog.render(this.demographicSpec(() => dialog, () => this.emit("kycComplete", undefined)));
              } else {
                dialog.render({ name: "kyc-not-allowed", title: "This account can't be verified", body: [note("Lucra has closed or restricted this account under its own rules. There is nothing to retry here; Lucra support can say more.")], actions: [button("Close", SECONDARY, () => dialog.close())] });
              }
            } catch (err) {
              dialog.render({ name: "kyc-error", title: "Verification didn't complete", body: [note(err instanceof Error ? err.message : "Try again.")], actions: [button("Close", SECONDARY, () => dialog.close())] });
            }
          },
          { "data-lucra-mock-action": "kyc" },
        ),
      ],
    });
    return dialog;
  }

  private demographicSpec(getDialog: () => SdkDialog & { render: (next: SheetSpec) => void }, after?: () => void): SheetSpec {
    return {
      name: "demographic",
      title: "A few details for free-to-play",
      body: [note("For free-to-play tournaments Lucra collects a short demographic form instead of a full identity check. Lucra's form asks for them; Sideout never collects them."), note("The mock records the form as complete.")],
      actions: [
        button(
          "Save details",
          PRIMARY,
          async () => {
            const dialog = getDialog();
            try {
              const { user } = await callMock({ action: "demographic" });
              this.setUser(user);
              this.emit("demographicComplete", undefined);
              after?.();
              dialog.close();
            } catch (err) {
              dialog.render({ name: "demographic-error", title: "The form didn't save", body: [note(err instanceof Error ? err.message : "Try again.")], actions: [button("Close", SECONDARY, () => dialog.close())] });
            }
          },
          { "data-lucra-mock-action": "demographic" },
        ),
      ],
    };
  }

  private presentDemographic(): SdkDialog {
    const dialog = this.present(this.demographicSpec(() => dialog));
    return dialog;
  }

  private presentFunds(kind: "deposit" | "withdraw"): SdkDialog {
    const amounts = [1000, 2500, 5000];
    const title = kind === "deposit" ? "Add funds" : "Withdraw";
    const spec = (): SheetSpec => ({
      name: kind,
      title,
      body: [
        note(kind === "deposit" ? "Lucra's own deposit flow (card, Apple Pay) runs here in sandbox and production. The mock credits the amount to the mock wallet." : "Lucra's own withdrawal flow runs here in sandbox and production. The mock debits the mock wallet."),
        fact("Balance", dollars(this._user)),
        note("Set deposit limits, take a break or self-exclude at any time under Lucra's Self Control settings."),
      ],
      actions: amounts.map((cents, i) =>
        button(
          `$${cents / 100}`,
          i === amounts.length - 1 ? PRIMARY : SECONDARY,
          async () => {
            try {
              const { user } = await callMock({ action: kind, amountCents: cents });
              this.setUser(user);
              dialog.close();
            } catch (err) {
              dialog.render({ name: `${kind}-error`, title: `${title} didn't go through`, body: [note(err instanceof Error ? err.message : "Try again.")], actions: [button("Back", SECONDARY, () => dialog.render(spec()))] });
            }
          },
          { "data-lucra-mock-action": `${kind}-${cents}` },
        ),
      ),
    });
    const dialog = this.present(spec());
    return dialog;
  }

  private presentWallet(): SdkDialog {
    const dialog = this.present({
      name: "wallet",
      title: "Wallet",
      body: [fact("Balance", dollars(this._user)), fact("Account", this._user?.accountStatus ?? "—"), note("Deposits, withdrawals, limits and self-exclusion are Lucra's own screens; the mock offers the two money flows.")],
      actions: [button("Withdraw", SECONDARY, () => this.presentFunds("withdraw")), button("Add funds", PRIMARY, () => this.presentFunds("deposit"))],
    });
    return dialog;
  }

  private presentProfile(): SdkDialog {
    const dialog = this.present({
      name: "profile",
      title: "Lucra profile",
      body: [fact("Username", this._user?.username ?? "—"), fact("Account", this._user?.accountStatus ?? "—"), fact("Balance", dollars(this._user)), note("Self Control — deposit limits, time-outs and self-exclusion — lives on this screen in Lucra's app.")],
      actions: [button("Sign out of Lucra", SECONDARY, () => {
        this.logout();
        dialog.close();
      }), button("Done", PRIMARY, () => dialog.close())],
    });
    return dialog;
  }

  private presentLocationGrant(): SdkDialog {
    const dialog = this.present({
      name: "location-grant",
      title: "Allow location access",
      body: [note("Lucra checks that you are somewhere it operates before you enter a tournament. Browsers only grant an iframe location from a tap inside it, which is why Lucra asks here."), note("The mock records the grant in this browser.")],
      actions: [
        button("Not now", GHOST, () => dialog.close()),
        button(
          "Allow location",
          PRIMARY,
          () => {
            storage()?.setItem(MOCK_LOCATION_KEY, "granted");
            this.emit("locationGranted", undefined);
            dialog.close();
          },
          { "data-lucra-mock-action": "location-grant" },
        ),
      ],
    });
    return dialog;
  }

  private presentTournament(matchupId: string): SdkDialog {
    const dialog = this.present({ name: "tournament", title: "Tournament", body: [note("Loading…")], actions: [button("Close", SECONDARY, () => dialog.close())] });
    void callMock({ action: "tournament", matchupId })
      .then(({ tournament }) => {
        dialog.render({
          name: "tournament",
          title: tournament.title,
          body: [
            fact("Status", tournament.status),
            fact("Players entered", String(tournament.participants)),
            fact("Buy-in", tournament.buyInCents === 0 ? "Free to play" : `$${(tournament.buyInCents / 100).toFixed(2)}`),
            tournament.you ? fact("Your score", tournament.you.score === null ? "No score yet" : `${tournament.you.score}${tournament.you.position ? ` · ${ordinal(tournament.you.position)}` : ""}`) : fact("You", "Not entered"),
            ...(tournament.rewards.length ? [h("p", { style: `${LABEL}margin:8px 0 0;` }, "Rewards"), ...tournament.rewards.map((r) => fact(`${ordinal(r.position)}${r.userName ? ` · ${r.userName}` : ""}`, r.value === 0 ? "Sponsor reward" : `$${(r.value / 100).toFixed(2)}`))] : [note("Rewards are assigned when the organizer closes the event.")]),
          ],
          actions: [button("Close", PRIMARY, () => dialog.close())],
        });
      })
      .catch((err: unknown) => {
        dialog.render({ name: "tournament-error", title: "Tournament", body: [note(err instanceof Error ? err.message : "Could not load the tournament.")], actions: [button("Close", SECONDARY, () => dialog.close())] });
      });
    return dialog;
  }

  dialog(): SdkDialogNavigation {
    return {
      profile: () => this.presentProfile(),
      wallet: () => this.presentWallet(),
      deposit: () => this.presentFunds("deposit"),
      withdraw: () => this.presentFunds("withdraw"),
      kyc: () => this.presentKyc(),
      demographic: () => this.presentDemographic(),
      locationGrant: () => this.presentLocationGrant(),
      tournamentDetails: (matchupId: string) => this.presentTournament(matchupId),
    };
  }

  // -- api ------------------------------------------------------------------------

  api = {
    /** The explicit entry (never auto-join): the same gates the SDK documents, then the mock's join and its `TournamentUserJoined`. */
    joinTournament: async (tournamentId: string): Promise<{ matchupId: string }> => {
      if (!this._user) throw new LucraUserNotLoggedIn();
      if (storage()?.getItem(MOCK_LOCATION_KEY) !== "granted") throw new LucraApiError(LucraApiErrorCode.locationNeeded);
      const { matchupId } = await callMock({ action: "join", matchupId: tournamentId });
      this.emit("tournamentJoined", { matchupId });
      return { matchupId };
    },
  };

  sendMessage = {
    /** The documented user link: metadata (`externalId`) stored on the Lucra user. */
    userUpdated: (data: { metadata?: Record<string, string> | null }): void => {
      void callMock({ action: "userUpdated", metadata: data.metadata ?? null })
        .then(({ user }) => this.setUser(user))
        .catch(() => undefined);
    },
  };
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}
