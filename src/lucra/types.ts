import { z } from "zod";
import { LUCRA_WEBHOOK_EVENTS } from "@/lucra/endpoints";
import type { LucraErrorCode } from "@/lucra/errors";

/**
 * Zod schemas for every Lucra request and response Sideout sends or reads
 * (spec §8). Requests are validated before they leave; responses are parsed on
 * the way in and a shape mismatch is an error (§8.1). Shapes are the legacy
 * documented ones (see `endpoints.ts`).
 *
 * The one deliberate deviation from the spec's §7.2 example: the type-specific
 * `POST /pool-tournament/user-score` takes a single `userScore` object, not a
 * `userScores` array — the GYP matching page says so in as many words
 * ("Unlike the tournament score ingestion endpoint which accepts a single user
 * score, this endpoint accepts an array"). The generic `/user-score` and the
 * recreational endpoint take the array.
 */

// ---------------------------------------------------------------------------
// Metadata values
// ---------------------------------------------------------------------------

export type MetadataValue = string | number | boolean | null | MetadataValue[] | { [key: string]: MetadataValue };
export type Metadata = Record<string, MetadataValue>;

export const metadataValueSchema: z.ZodType<MetadataValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(metadataValueSchema), z.record(z.string(), metadataValueSchema)]),
);
export const metadataSchema: z.ZodType<Metadata> = z.record(z.string(), metadataValueSchema);

// ---------------------------------------------------------------------------
// Matchup targeting (§7.3)
// ---------------------------------------------------------------------------

/**
 * The only two ways Sideout may aim a write: a concrete matchup id, or a
 * metadata object whose *only* key is `externalId` (rule 7.3.2). The zod
 * schema is `.strict()` so any extra key is refused at runtime; the TS union
 * refuses it for object literals at compile time.
 */
export const strictExternalIdSchema = z.object({ externalId: z.string().min(1) }).strict();
export const strictMatchupTargetSchema = z.union([z.object({ matchupId: z.string().min(1) }).strict(), z.object({ matchupMetadata: strictExternalIdSchema }).strict()]);
export type StrictMatchupTarget = { matchupId: string; matchupMetadata?: never } | { matchupMetadata: { externalId: string }; matchupId?: never };

/** Anything Lucra accepts as matchup criteria, including the loose metadata bags Sideout never writes with. */
export const matchupCriteriaSchema = z
  .object({
    matchupId: z.string().min(1).optional(),
    matchupMetadata: metadataSchema.optional(),
    gameId: z.string().min(1).optional(),
    locationId: z.string().min(1).optional(),
  })
  .strict();
export type MatchupCriteria = z.infer<typeof matchupCriteriaSchema>;

// ---------------------------------------------------------------------------
// Users and scores
// ---------------------------------------------------------------------------

const userIdentifierFields = {
  userId: z.string().min(1).optional(),
  phoneNumber: z.string().min(1).optional(),
  userMetadata: metadataSchema.optional(),
};

function hasUserIdentifier(v: { userId?: string | undefined; phoneNumber?: string | undefined; userMetadata?: Metadata | undefined }): boolean {
  return v.userId !== undefined || v.phoneNumber !== undefined || v.userMetadata !== undefined;
}

/** One participant's score. Sideout identifies users by `userMetadata.externalId` only (never phone or email). */
export const userScoreEntrySchema = z
  .object({
    ...userIdentifierFields,
    score: z.number().finite(),
    metadata: metadataSchema.optional(),
    attemptFinished: z.boolean().optional(),
  })
  .strict()
  .refine(hasUserIdentifier, { message: "One user identifier is required: userId, phoneNumber or userMetadata." });
export type UserScoreEntry = z.infer<typeof userScoreEntrySchema>;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const poolTournamentUserScoreRequestSchema = z
  .object({
    object: z.object({ ...matchupCriteriaSchema.shape, userScore: userScoreEntrySchema }).strict(),
  })
  .strict();
export type PoolTournamentUserScoreRequest = z.infer<typeof poolTournamentUserScoreRequestSchema>;

export const genericUserScoreRequestSchema = z
  .object({
    object: z.object({ ...matchupCriteriaSchema.shape, userScores: z.array(userScoreEntrySchema).min(1) }).strict(),
  })
  .strict();
export type GenericUserScoreRequest = z.infer<typeof genericUserScoreRequestSchema>;

/** Recreational games take the same array shape (no `locationId`). */
export const recreationalUserScoreRequestSchema = z
  .object({
    object: z
      .object({
        matchupId: z.string().min(1).optional(),
        matchupMetadata: metadataSchema.optional(),
        gameId: z.string().min(1).optional(),
        userScores: z.array(userScoreEntrySchema).min(1),
      })
      .strict(),
  })
  .strict();
export type RecreationalUserScoreRequest = z.infer<typeof recreationalUserScoreRequestSchema>;

export const poolTournamentQueryRequestSchema = z
  .object({
    object: z.object({ ...matchupCriteriaSchema.shape, ...userIdentifierFields }).strict(),
  })
  .strict();
export type PoolTournamentQueryRequest = z.infer<typeof poolTournamentQueryRequestSchema>;

export const paymentStructureEntrySchema = z
  .object({
    position: z.number().int().min(1),
    positionOverride: z.number().int().min(1).optional(),
    /** Currency units, not cents: the documented examples pay `500` for $500. */
    value: z.number().nonnegative(),
    userId: z.string().min(1),
  })
  .strict();
export type PaymentStructureEntry = z.infer<typeof paymentStructureEntrySchema>;

export const completeTournamentRequestSchema = z
  .object({
    object: z
      .object({
        type: z.enum(["CASH_FIXED", "CASH_PERCENTAGE"]).optional(),
        minPayoutAmount: z.number().nonnegative().optional(),
        paymentStructure: z.array(paymentStructureEntrySchema),
        title: z.string().optional(),
        description: z.string().optional(),
        metadataString: z.string().optional(),
      })
      .strict(),
  })
  .strict();
export type CompleteTournamentRequest = z.infer<typeof completeTournamentRequestSchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * `status` is `"success"` even on partial failure; a non-empty
 * `failedMatchupIds` is the real failure signal (§7.2). The recreational
 * endpoint omits `failedMatchupIds`, hence the default.
 */
export const userScoreResponseSchema = z.object({
  status: z.literal("success"),
  data: z.object({
    affectedMatchupIds: z.array(z.string()),
    failedMatchupIds: z.array(z.string()).default([]),
  }),
});
export type UserScoreResponse = z.infer<typeof userScoreResponseSchema>;

export const queryResponseSchema = z.object({ status: z.literal("success"), data: z.array(z.string()) });
export type QueryResponse = z.infer<typeof queryResponseSchema>;

export const LUCRA_MATCHUP_STATUSES = ["OPEN", "CONFIRMED", "CLOSED", "CANCELED"] as const;
export type LucraMatchupStatus = (typeof LUCRA_MATCHUP_STATUSES)[number];

/** A leaderboard row. Everything beyond the identifiers is optional: the read is for reconciliation, not display. */
export const tournamentUserSchema = z.looseObject({
  userId: z.string().min(1),
  userName: z.string().nullable().optional(),
  userMetadata: metadataSchema.nullable().optional(),
  position: z.number().nullable().optional(),
  positionOverride: z.number().nullable().optional(),
  score: z.number().nullable().optional(),
  canSubmitNewScore: z.boolean().optional(),
});
export type TournamentUser = z.infer<typeof tournamentUserSchema>;

export const rewardStructureEntrySchema = z.looseObject({
  position: z.number(),
  positionOverride: z.number().nullable().optional(),
  value: z.number().nullable().optional(),
  userId: z.string().nullable().optional(),
});

export const tournamentMatchupSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string(),
  type: z.string().optional(),
  gameId: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  metadata: metadataSchema.nullable().optional(),
  numberOfParticipants: z.number().optional(),
  users: z.array(tournamentUserSchema).default([]),
  rewardStructure: z.array(rewardStructureEntrySchema).default([]),
});
export type TournamentMatchup = z.infer<typeof tournamentMatchupSchema>;

export const getTournamentResponseSchema = z.object({ matchup: tournamentMatchupSchema });
export type GetTournamentResponse = z.infer<typeof getTournamentResponseSchema>;

/** `unassignedUserIds` is a warning, not an error: the tournament still completed. */
export const completeTournamentResponseSchema = z.object({
  status: z.literal("success"),
  data: z.unknown().optional(),
  unassignedUserIds: z.array(z.string()).default([]),
});
export type CompleteTournamentResponse = z.infer<typeof completeTournamentResponseSchema>;

// ---------------------------------------------------------------------------
// Webhooks (§7.6)
// ---------------------------------------------------------------------------

const tournamentEventBase = {
  tenantId: z.string().optional(),
  matchup: tournamentMatchupSchema,
};

export const tournamentCompletedEventSchema = z.looseObject({
  event: z.literal(LUCRA_WEBHOOK_EVENTS.tournamentCompleted),
  mode: z.enum(["auto", "manual", "admin"]).optional(),
  ...tournamentEventBase,
});
export const tournamentUserJoinedEventSchema = z.looseObject({
  event: z.literal(LUCRA_WEBHOOK_EVENTS.tournamentUserJoined),
  newUserId: z.string().min(1),
  userMetadata: metadataSchema.nullable().optional(),
  ...tournamentEventBase,
});
export const tournamentCanceledEventSchema = z.looseObject({ event: z.literal(LUCRA_WEBHOOK_EVENTS.tournamentCanceled), ...tournamentEventBase });
export const tournamentCreatedEventSchema = z.looseObject({ event: z.literal(LUCRA_WEBHOOK_EVENTS.tournamentCreated), ...tournamentEventBase });
export const tournamentEditedEventSchema = z.looseObject({ event: z.literal(LUCRA_WEBHOOK_EVENTS.tournamentEdited), ...tournamentEventBase });
export const userSignedUpEventSchema = z.looseObject({
  event: z.literal(LUCRA_WEBHOOK_EVENTS.userSignedUp),
  userId: z.string().min(1),
  email: z.string().nullable().optional(),
  username: z.string().nullable().optional(),
  phoneNumber: z.string().nullable().optional(),
});
export const userKycVerifiedEventSchema = z.looseObject({ event: z.literal(LUCRA_WEBHOOK_EVENTS.userKycVerified), userId: z.string().min(1) });

/** Every event type Sideout handles. Anything else that is well-formed is ignored with a 2xx. */
export const knownWebhookEventSchema = z.discriminatedUnion("event", [
  tournamentCompletedEventSchema,
  tournamentUserJoinedEventSchema,
  tournamentCanceledEventSchema,
  tournamentCreatedEventSchema,
  tournamentEditedEventSchema,
  userSignedUpEventSchema,
  userKycVerifiedEventSchema,
]);
export type KnownWebhookEvent = z.infer<typeof knownWebhookEventSchema>;

/** The minimum any Lucra webhook carries: an `event` name. */
export const webhookEnvelopeSchema = z.looseObject({ event: z.string().min(1) });

// ---------------------------------------------------------------------------
// What the client records per call
// ---------------------------------------------------------------------------

/** What went over the wire, safe to persist: the key is never in it. */
export interface CallRecord {
  method: "GET" | "POST";
  path: string;
  request: { headers: Record<string, string>; body: unknown };
  response: { status: number; body: unknown } | null;
  tries: number;
  startedAt: number;
  finishedAt: number;
  error: { code: LucraErrorCode; message: string } | null;
}
