import "server-only";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { getDb } from "@/db/client";
import { users, type User } from "@/db/schema";
import { env } from "@/env";
import { systemClock, type Clock } from "@/lib/clock";
import { SESSION_COOKIE, verifySession } from "@/server/auth/session";

/** The account behind a session cookie value, or null for anything that is not a valid session. */
export function userForSessionToken(token: string | undefined, clock: Clock = systemClock): User | null {
  const uid = verifySession(token, env.sessionSecret, clock)?.uid;
  if (!uid) return null;
  return getDb().select().from(users).where(eq(users.id, uid)).get() ?? null;
}

/** The signed-in user rendering a server component, read from the request cookies; null when anonymous. */
export async function viewer(): Promise<User | null> {
  const store = await cookies();
  return userForSessionToken(store.get(SESSION_COOKIE)?.value);
}

export type OrganizerGate = { organizer: User } | { organizer: null; user: User | null };

/**
 * The organizer rendering an organizer console page, or who must be refused.
 * The dispute queue and the close flow gate on this and explain the refusal;
 * the console pages and their layout 404 through `requireOrganizerViewer`
 * (`src/app/organizer/_lib.ts`). Either way the gate sits in the page, ahead
 * of its data: a layout that hides its children does not keep a page segment
 * out of the RSC payload.
 */
export async function organizerViewer(): Promise<OrganizerGate> {
  const user = await viewer();
  return user?.role === "organizer" ? { organizer: user } : { organizer: null, user };
}
