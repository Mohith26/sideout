import "server-only";
import { notFound } from "next/navigation";
import type { User } from "@/db/schema";
import { viewer } from "@/server/auth/viewer";

/**
 * The console is role-gated on the server (spec §9, §11.6): a player, or
 * anyone signed out, gets the same 404 an unknown path gives, so the console's
 * existence is not advertised to accounts that cannot use it.
 */
export function isConsoleViewer(user: User | null): user is User & { role: "organizer" } {
  return user?.role === "organizer";
}

export async function requireOrganizerViewer(): Promise<User> {
  const user = await viewer();
  if (!isConsoleViewer(user)) notFound();
  return user;
}
