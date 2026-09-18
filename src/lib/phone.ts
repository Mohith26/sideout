import { z } from "zod";

/**
 * Phone numbers are stored as E.164 (`users.phone_e164`) and are the key for
 * sign-in and partner invites, so every entry point normalizes through here.
 *
 * Accepted input: an E.164 string with any spacing, dashes, dots or
 * parentheses, or a bare 10-digit North American number (an 11-digit one
 * starting with 1 is the same thing with its country code). Anything else is
 * rejected rather than guessed at.
 */
const E164 = /^\+[1-9]\d{7,14}$/;

export function normalizePhone(input: string): string | null {
  const stripped = input.trim().replace(/[\s().-]/g, "");
  if (stripped === "") return null;
  if (stripped.startsWith("+")) return E164.test(stripped) ? stripped : null;
  if (/^\d{10}$/.test(stripped)) return `+1${stripped}`;
  if (/^1\d{10}$/.test(stripped)) return `+${stripped}`;
  return null;
}

/** Zod input: any accepted form in, E.164 out. */
export const phoneSchema = z
  .string()
  .trim()
  .min(1, "Phone number is required.")
  .transform((value, ctx) => {
    const normalized = normalizePhone(value);
    if (normalized === null) {
      ctx.addIssue({ code: "custom", message: "Enter a phone number in international format, like +1 555 010 0100." });
      return z.NEVER;
    }
    return normalized;
  });

/** "+15550100100" → "•••• 0100" for logs and UI that must not show the full number. */
export function maskPhone(e164: string): string {
  return `•••• ${e164.slice(-4)}`;
}
