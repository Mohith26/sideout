import { LucraApiError, LucraApiErrorCode, LucraUserNotLoggedIn } from "@/lucra/sdk-mock";

/** The stand-in's sealed error classes, for scripting failures in component tests. */
export { LucraApiError, LucraApiErrorCode, LucraUserNotLoggedIn };
import type { LucraSdkModule, SdkClient, SdkClientConfig, SdkDialog, SdkDialogNavigation, SdkEventMap, SdkUser } from "@/lucra/sdk-surface";

/**
 * A scripted Lucra SDK module for component tests: the same sealed error
 * classes the stand-in exports (and the real package's codes), a client
 * whose `ready`, `joinTournament` and dialogs follow a `Script`, and the
 * `LucraClient` static surface `LucraGate` initializes through `loadSdk`.
 */
export interface Script {
  /** What `client.ready` does: resolve (signed in), reject not-logged-in, or reject with a failed initialized body. */
  ready?: "signed_in" | "signed_out" | "init_failed";
  user?: SdkUser | null;
  /** Rejections for successive `joinTournament` calls; a `null` entry resolves. */
  join?: Array<unknown | null>;
  /** Which dialogs complete (fire their event) when opened; the rest close without it. */
  completes?: Partial<Record<keyof SdkDialogNavigation, boolean>>;
}

export class FakeClient implements SdkClient {
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

export function moduleFor(script: Script): { mod: LucraSdkModule; clients: FakeClient[] } {
  const clients: FakeClient[] = [];
  let instance: FakeClient | null = null;
  const mod: LucraSdkModule = {
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
  return { mod, clients };
}
