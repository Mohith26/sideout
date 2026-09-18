import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/env";
import { systemClock, type Clock } from "@/lib/clock";

/**
 * Sideout's own session: a signed, HttpOnly, SameSite=Lax cookie carrying the
 * user id and an expiry. Stateless by design (the brief asks for the minimum):
 * there is no sessions table, so signing out clears the cookie and rotating
 * `SESSION_SECRET` ends every session at once. Lucra owns wallet identity;
 * this only says which Sideout account is talking to us.
 *
 * Token: `v1.<base64url payload>.<base64url HMAC-SHA256(payload)>`.
 */

export const SESSION_COOKIE = "sideout_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const payloadSchema = z.object({
  v: z.literal(1),
  uid: z.string().min(1),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
});
export type SessionPayload = z.infer<typeof payloadSchema>;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signSession(userId: string, secret: string, clock: Clock = systemClock): string {
  const iat = clock.now();
  const payload: SessionPayload = { v: 1, uid: userId, iat, exp: iat + SESSION_TTL_MS };
  const encoded = b64url(JSON.stringify(payload));
  return `v1.${encoded}.${sign(encoded, secret)}`;
}

/** Null for anything that is not a currently valid token signed with `secret`. */
export function verifySession(token: string | undefined, secret: string, clock: Clock = systemClock): SessionPayload | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, encoded, signature] = parts;
  if (!encoded || !signature) return null;
  const expected = Buffer.from(sign(encoded, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    // Signed by us but not JSON: impossible unless the secret leaked; treat as no session.
    return null;
  }
  const result = payloadSchema.safeParse(parsed);
  if (!result.success) return null;
  if (result.data.exp <= clock.now()) return null;
  return result.data;
}

export function readSessionUserId(request: NextRequest, clock: Clock = systemClock): string | null {
  return verifySession(request.cookies.get(SESSION_COOKIE)?.value, env.sessionSecret, clock)?.uid ?? null;
}

export function setSessionCookie(response: NextResponse, userId: string, clock: Clock = systemClock): void {
  response.cookies.set(SESSION_COOKIE, signSession(userId, env.sessionSecret, clock), {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}
