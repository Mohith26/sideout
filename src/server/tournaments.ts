import "server-only";
import { and, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import {
  getTournamentDetail,
  getTournamentSummaryById,
  getTournamentSummaryBySlug,
  isPublished,
  listTournamentSummaries,
  publicSummary,
  type PublicTournamentDetail,
  type PublicTournamentSummary,
  type TournamentDetail,
  type TournamentSummary,
} from "@/db/queries/tournaments";
import {
  charities,
  DIVISIONS,
  donations,
  matches,
  PRIZE_KINDS,
  SPONSOR_TIERS,
  sponsors,
  teams,
  TOURNAMENT_FORMATS,
  TOURNAMENT_STATUSES,
  tournaments,
  type NewSponsor,
  type Sponsor,
  type Tournament,
  type TournamentStatus,
} from "@/db/schema";
import { transitionTournament, type TransitionActor } from "@/domain/transitions";
import { env } from "@/env";
import { ApiFailure } from "@/lib/api";
import { systemClock, type Clock } from "@/lib/clock";
import { shortId, uuidv7 } from "@/lib/uuid";
import { writeAudit, type Tx } from "@/server/audit";
import { sweepDueDonations } from "@/server/donations/stub-provider";

/**
 * Organizer tournament service: create, edit every editable column plus the
 * sponsor list, and move status through the state machine. Every write is one
 * transaction with its audit rows. Reads for the public routes are re-exported
 * from `@/db/queries` so the route layer has one import.
 */

// OPEN: (§17.5) gameId registration for an outdoor, non-fixed venue sport is
// unresolved; one constant for the whole product until Lucra clarifies.
export const LUCRA_GAME_ID = "SIDEOUT_BEACH_2V2";

const slugSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase letters, digits and single hyphens.");

const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "venueTimezone must be an IANA time zone, like America/Los_Angeles.");

const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "currency must be a three-letter ISO code.");

export const sponsorInputSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(80),
  logoUrl: z.url().nullable().optional(),
  tier: z.enum(SPONSOR_TIERS),
  prizeContributionCents: z.number().int().nonnegative(),
  currency: currencySchema.optional(),
});
export type SponsorInput = z.infer<typeof sponsorInputSchema>;

const editableFields = {
  slug: slugSchema,
  name: z.string().trim().min(2).max(120),
  subtitle: z.string().trim().max(200).nullable(),
  beneficiaryId: z.string().min(1),
  venueName: z.string().trim().min(1).max(120),
  venueCity: z.string().trim().min(1).max(80),
  venueState: z.string().trim().min(2).max(3).toUpperCase(),
  venueTimezone: timezoneSchema,
  startsAt: z.number().int().positive(),
  endsAt: z.number().int().positive(),
  format: z.enum(TOURNAMENT_FORMATS),
  division: z.enum(DIVISIONS),
  maxTeams: z.number().int().min(2).max(256),
  entryDonationCents: z.number().int().nonnegative(),
  fundraisingGoalCents: z.number().int().nonnegative(),
  currency: currencySchema,
  prizeKind: z.enum(PRIZE_KINDS),
  lucraGameId: z.string().trim().min(1).max(80),
  lucraLocationId: z.string().trim().min(1).max(120).nullable(),
};

export const createTournamentSchema = z
  .object({
    ...editableFields,
    subtitle: editableFields.subtitle.optional(),
    currency: editableFields.currency.default("USD"),
    prizeKind: editableFields.prizeKind.default("free_to_play_rewards"),
    lucraGameId: editableFields.lucraGameId.default(LUCRA_GAME_ID),
    lucraLocationId: editableFields.lucraLocationId.optional(),
    sponsors: z.array(sponsorInputSchema).max(50).optional(),
  })
  .strict();
export type CreateTournamentInput = z.infer<typeof createTournamentSchema>;

export const updateTournamentSchema = z
  .object(editableFields)
  .partial()
  .extend({
    status: z.enum(TOURNAMENT_STATUSES).optional(),
    sponsors: z.array(sponsorInputSchema).max(50).optional(),
  })
  .strict();
export type UpdateTournamentInput = z.infer<typeof updateTournamentSchema>;

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/** A draft is unpublished: slug lookups, which serve the public and player routes, do not see it. */
export function requireTournamentBySlug(slug: string): TournamentSummary {
  const summary = getTournamentSummaryBySlug(slug);
  if (!summary || !isPublished(summary.tournament.status)) throw new ApiFailure("not_found", "No tournament with that slug.");
  return summary;
}

export function requireTournamentById(id: string): TournamentSummary {
  const summary = getTournamentSummaryById(id);
  if (!summary) throw new ApiFailure("not_found", "No tournament with that id.");
  return summary;
}

/** Public reads carry donation figures, so the stub sweep runs first: the same event answers the same on every route. */
export function listPublicTournaments(statuses?: readonly TournamentStatus[], clock: Clock = systemClock): PublicTournamentSummary[] {
  const wanted = (statuses ?? TOURNAMENT_STATUSES).filter(isPublished);
  if (wanted.length === 0) return [];
  sweepDueDonations(clock.now());
  return listTournamentSummaries(wanted).map(publicSummary);
}

export function getPublicDetailBySlug(slug: string, clock: Clock = systemClock): PublicTournamentDetail {
  const summary = requireTournamentBySlug(slug);
  sweepDueDonations(clock.now());
  return publicSummary(getTournamentDetail(requireTournamentById(summary.tournament.id)));
}

export function getDetailById(id: string): TournamentDetail {
  return getTournamentDetail(requireTournamentById(id));
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

function assertCharity(db: Tx, id: string): void {
  if (!db.select({ id: charities.id }).from(charities).where(eq(charities.id, id)).get()) {
    throw new ApiFailure("bad_request", "beneficiaryId does not match a charity.");
  }
}

function assertSlugFree(db: Tx, slug: string, exceptId?: string): void {
  const taken = db
    .select({ id: tournaments.id })
    .from(tournaments)
    .where(exceptId ? and(eq(tournaments.slug, slug), ne(tournaments.id, exceptId)) : eq(tournaments.slug, slug))
    .get();
  if (taken) throw new ApiFailure("conflict", `The slug "${slug}" is already in use.`);
}

function assertPrizeKindAllowed(prizeKind: Tournament["prizeKind"]): void {
  // Spec §4.2: the real-money path exists but stays behind FEATURE_REAL_MONEY, default off.
  if (prizeKind === "real_money" && !env.FEATURE_REAL_MONEY) {
    throw new ApiFailure("forbidden", "Real-money events are disabled (FEATURE_REAL_MONEY=false).");
  }
}

export function createTournament(input: CreateTournamentInput, actor: TransitionActor, clock: Clock = systemClock): TournamentDetail {
  const db = getDb();
  if (input.endsAt < input.startsAt) throw new ApiFailure("bad_request", "endsAt must not be before startsAt.");
  assertPrizeKindAllowed(input.prizeKind);
  assertCharity(db, input.beneficiaryId);
  assertSlugFree(db, input.slug);
  const now = clock.now();
  const id = uuidv7();
  const { sponsors: sponsorInputs, ...fields } = input;

  db.transaction((tx) => {
    tx.insert(tournaments)
      .values({
        ...fields,
        id,
        subtitle: fields.subtitle ?? null,
        lucraLocationId: fields.lucraLocationId ?? null,
        status: "draft",
        lucraMatchupId: null,
        // Namespaced and globally unique (spec §7.3.3).
        lucraExternalId: `sideout-${fields.slug}-${shortId(id)}`,
        createdAt: now,
      })
      .run();
    writeAudit(tx, { actor, action: "tournament.created", subjectType: "tournament", subjectId: id, detail: { slug: fields.slug, format: fields.format }, at: now });
    if (sponsorInputs) replaceSponsors(tx, id, fields.currency, sponsorInputs, actor, now);
  });
  return getDetailById(id);
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/** Edges the PATCH route may take; closing is `@/server/close` (preview, hash, confirm) and `settled` is the settlement outcome (phase 4). */
export type PatchableTarget = "registration_open" | "registration_closed" | "live" | "cancelled";
const PATCHABLE_TARGETS: ReadonlySet<TournamentStatus> = new Set<PatchableTarget>(["registration_open", "registration_closed", "live", "cancelled"]);

export function isPatchableTarget(status: TournamentStatus): status is PatchableTarget {
  return PATCHABLE_TARGETS.has(status);
}

export function updateTournament(id: string, input: UpdateTournamentInput, actor: TransitionActor, clock: Clock = systemClock): TournamentDetail {
  const db = getDb();
  const current = db.select().from(tournaments).where(eq(tournaments.id, id)).get();
  if (!current) throw new ApiFailure("not_found", "No tournament with that id.");
  const now = clock.now();
  const { status: nextStatus, sponsors: sponsorInputs, ...fields } = input;

  const changes: Partial<Tournament> = {};
  for (const [key, value] of Object.entries(fields) as Array<[keyof typeof fields, unknown]>) {
    if (value === undefined) continue;
    if (current[key] !== value) (changes as Record<string, unknown>)[key] = value;
  }

  const matchCount = db.select({ n: sql<number>`count(*)` }).from(matches).where(eq(matches.tournamentId, id)).get()?.n ?? 0;
  const donationCount = db.select({ n: sql<number>`count(*)` }).from(donations).where(eq(donations.tournamentId, id)).get()?.n ?? 0;
  const activeTeams = db
    .select({ n: sql<number>`count(*)` })
    .from(teams)
    .where(and(eq(teams.tournamentId, id), inArray(teams.status, ["registered", "checked_in"])))
    .get()?.n ?? 0;

  if (changes.slug !== undefined) assertSlugFree(db, changes.slug, id);
  if (changes.beneficiaryId !== undefined) {
    if (donationCount > 0) throw new ApiFailure("conflict", "The beneficiary cannot change once donations have been made.");
    assertCharity(db, changes.beneficiaryId);
  }
  if (changes.currency !== undefined && donationCount > 0) throw new ApiFailure("conflict", "The currency cannot change once donations have been made.");
  if (changes.format !== undefined && matchCount > 0) throw new ApiFailure("conflict", "The format cannot change after the draw; clear the draw first.");
  if (changes.maxTeams !== undefined && changes.maxTeams < activeTeams) {
    throw new ApiFailure("conflict", `maxTeams cannot go below the ${activeTeams} teams already registered.`);
  }
  if (changes.prizeKind !== undefined) assertPrizeKindAllowed(changes.prizeKind);
  const startsAt = changes.startsAt ?? current.startsAt;
  const endsAt = changes.endsAt ?? current.endsAt;
  if (endsAt < startsAt) throw new ApiFailure("bad_request", "endsAt must not be before startsAt.");
  if (current.status === "settled" || current.status === "cancelled") {
    if (Object.keys(changes).length > 0 || sponsorInputs) throw new ApiFailure("conflict", `A ${current.status} tournament is read-only.`);
  }

  let transition: { from: TournamentStatus; to: TournamentStatus } | null = null;
  if (nextStatus !== undefined && nextStatus !== current.status) {
    if (!isPatchableTarget(nextStatus)) {
      throw new ApiFailure(
        "conflict",
        nextStatus === "awaiting_settlement"
          ? "Closing goes through POST /api/admin/tournaments/:id/close with the hash from GET …/close/preview."
          : `Moving to ${nextStatus} is the outcome of settlement, not a status edit.`,
      );
    }
    const verdict = transitionTournament(current.status, nextStatus, actor);
    if (!verdict.ok) throw new ApiFailure("conflict", verdict.reason);
    if (nextStatus === "live" && matchCount === 0) throw new ApiFailure("conflict", "Generate the draw before going live.");
    transition = { from: current.status, to: nextStatus };
  }

  db.transaction((tx) => {
    if (Object.keys(changes).length > 0) {
      tx.update(tournaments).set(changes).where(eq(tournaments.id, id)).run();
      writeAudit(tx, { actor, action: "tournament.updated", subjectType: "tournament", subjectId: id, detail: { fields: Object.keys(changes) }, at: now });
    }
    if (sponsorInputs) replaceSponsors(tx, id, changes.currency ?? current.currency, sponsorInputs, actor, now);
    if (transition) {
      tx.update(tournaments).set({ status: transition.to }).where(eq(tournaments.id, id)).run();
      writeAudit(tx, { actor, action: "tournament.status_changed", subjectType: "tournament", subjectId: id, detail: transition, at: now });
    }
  });
  return getDetailById(id);
}

/** Replace the sponsor list: rows with a known id are updated, others inserted, the rest deleted. */
function replaceSponsors(tx: Tx, tournamentId: string, defaultCurrency: string, inputs: readonly SponsorInput[], actor: TransitionActor, now: number): Sponsor[] {
  const existing = tx.select().from(sponsors).where(eq(sponsors.tournamentId, tournamentId)).all();
  const existingIds = new Set(existing.map((s) => s.id));
  const keep: string[] = [];
  for (const input of inputs) {
    const row: NewSponsor = {
      id: input.id && existingIds.has(input.id) ? input.id : uuidv7(),
      tournamentId,
      name: input.name,
      logoUrl: input.logoUrl ?? null,
      tier: input.tier,
      prizeContributionCents: input.prizeContributionCents,
      currency: input.currency ?? defaultCurrency,
    };
    if (input.id && !existingIds.has(input.id)) throw new ApiFailure("bad_request", `Sponsor ${input.id} does not belong to this tournament.`);
    if (existingIds.has(row.id)) {
      tx.update(sponsors).set(row).where(eq(sponsors.id, row.id)).run();
    } else {
      tx.insert(sponsors).values(row).run();
    }
    keep.push(row.id);
  }
  if (keep.length > 0) {
    tx.delete(sponsors).where(and(eq(sponsors.tournamentId, tournamentId), notInArray(sponsors.id, keep))).run();
  } else {
    tx.delete(sponsors).where(eq(sponsors.tournamentId, tournamentId)).run();
  }
  writeAudit(tx, { actor, action: "tournament.sponsors_updated", subjectType: "tournament", subjectId: tournamentId, detail: { count: keep.length }, at: now });
  return tx.select().from(sponsors).where(eq(sponsors.tournamentId, tournamentId)).all();
}
