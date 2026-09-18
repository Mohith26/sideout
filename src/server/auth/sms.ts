import "server-only";
import { env } from "@/env";
import { log } from "@/lib/log";
import { maskPhone } from "@/lib/phone";

/**
 * Outbound SMS seam. Sign-in codes and partner invites are delivered through
 * `getSmsSender()`; nothing else in the codebase sends a text.
 */
export interface SmsSender {
  /** Delivery is best-effort and synchronous from the caller's point of view. */
  send(toE164: string, body: string): void;
}

// OPEN: the SMS delivery provider is not specified anywhere in the brief
// (docs/open-questions.md, phase 2 additions). The fallback writes the message
// through `@/lib/log` — which is how the code reaches a developer — and, in
// production, warns on every send that no real provider is configured. When a
// provider is chosen it implements `SmsSender` and is returned from
// `getSmsSender()`; callers do not change.
export const logSmsSender: SmsSender = {
  send(toE164, body) {
    if (env.NODE_ENV === "production") {
      log.warn("sms: no delivery provider configured; message written to the log only", { to: maskPhone(toE164) });
    }
    log.info("sms", { to: maskPhone(toE164), body });
  },
};

export function getSmsSender(): SmsSender {
  return logSmsSender;
}
