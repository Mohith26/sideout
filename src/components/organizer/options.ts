import "server-only";
import type { EventFormOptions } from "@/components/organizer/EventForm";
import { listCharities } from "@/db/queries/charities";
import { DIVISIONS, PRIZE_KINDS, SPONSOR_TIERS, TOURNAMENT_FORMATS } from "@/db/schema";
import { env } from "@/env";
import { LUCRA_GAME_ID } from "@/server/tournaments";

/** What the builder's form needs from the server: enum vocabularies, beneficiaries, and the real-money flag. */
export function eventFormOptions(): EventFormOptions {
  return {
    formats: TOURNAMENT_FORMATS,
    divisions: DIVISIONS,
    prizeKinds: PRIZE_KINDS,
    tiers: SPONSOR_TIERS,
    charities: listCharities().map((c) => ({ id: c.id, name: c.name })),
    realMoneyEnabled: env.FEATURE_REAL_MONEY,
    defaultGameId: LUCRA_GAME_ID,
    defaultTimeZone: "America/Los_Angeles",
    defaultCurrency: "USD",
  };
}
