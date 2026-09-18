import "server-only";
import { asc } from "drizzle-orm";
import { getDb } from "@/db/client";
import { charities, type Charity } from "@/db/schema";

/** Beneficiaries an organizer can attach to an event. */
export function listCharities(): Charity[] {
  return getDb().select().from(charities).orderBy(asc(charities.name)).all();
}
