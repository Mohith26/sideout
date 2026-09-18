import "server-only";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { getDb } from "@/db/client";
import { users, type User } from "@/db/schema";
import { env } from "@/env";
import { systemClock, type Clock } from "@/lib/clock";
import { SESSION_COOKIE, verifySession, type SessionVia } from "@/server/auth/session";

export interface ViewerSession {
  user: User;
  /** How the session was opened; `demo` for the public demo's account picker. */
  via: SessionVia | null;
}

/** The account behind a session cookie value and how it signed in, or null for anything that is not a valid session. */
export function sessionForToken(token: string | undefined, clock: Clock = systemClock): ViewerSession | null {
  const payload = verifySession(token, env.sessionSecret, clock);
  if (!payload) return null;
  const user = getDb().select().from(users).where(eq(users.id, payload.uid)).get() ?? null;
  return user ? { user, via: payload.via ?? null } : null;
}

/** The account behind a session cookie value, or null for anything that is not a valid session. */
export function userForSessionToken(token: string | undefined, clock: Clock = systemClock): User | null {
  return sessionForToken(token, clock)?.user ?? null;
}

/** The signed-in session rendering a server component, read from the request cookies; null when anonymous. */
export async function viewerSession(): Promise<ViewerSession | null> {
  const store = await cookies();
  return sessionForToken(store.get(SESSION_COOKIE)?.value);
}

/** The signed-in user rendering a server component; null when anonymous. */
export async function viewer(): Promise<User | null> {
  return (await viewerSession())?.user ?? null;
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
