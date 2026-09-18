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
