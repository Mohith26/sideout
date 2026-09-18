import "server-only";
import { env } from "@/env";
import { ApiFailure } from "@/lib/api";
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

/**
 * Development stand-in: the message goes through `@/lib/log`, phone masked,
 * body in clear, which is how a sign-in code reaches a developer. Never used
 * in production, where a log line holding a live code would let anyone with
 * log access take over the account.
 */
export const logSmsSender: SmsSender = {
  send(toE164, body) {
    log.info("sms", { to: maskPhone(toE164), body });
  },
};

// OPEN: the SMS delivery provider is not specified anywhere in the brief
// (docs/open-questions.md, phase 2 additions). Outside production the log
// sender stands in; in production there is no sender until a provider is
// chosen, so anything that must deliver a text (`requireSmsSender`) refuses
// instead. A real provider implements `SmsSender` and is returned from here;
// callers do not change.
export function getSmsSender(): SmsSender | null {
  return env.NODE_ENV === "production" ? null : logSmsSender;
}

/** The sender for a message that cannot be skipped, such as a sign-in code. */
export function requireSmsSender(): SmsSender {
  const sender = getSmsSender();
  if (!sender) throw new ApiFailure("unavailable", "Text messages cannot be sent right now; no SMS provider is configured.", { code: "sms_unavailable" });
  return sender;
}
