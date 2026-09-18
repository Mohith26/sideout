import type { NextRequest } from "next/server";
import { z } from "zod";
import { listLucraSubmissions, listTournamentLucraStatus } from "@/db/queries/lucra";
import { LUCRA_SUBMISSION_OUTCOMES } from "@/db/schema";
import { ok } from "@/lib/api";
import { handle, NO_STORE, parseQuery, requireOrganizer } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z
  .object({
    tournamentId: z.string().min(1).optional(),
    matchId: z.string().min(1).optional(),
    outcome: z.enum(LUCRA_SUBMISSION_OUTCOMES).optional(),
  })
  .strict();

/**
 * GET /api/admin/lucra/submissions (spec §9, §11.6): every
 * `lucra_score_submissions` row with the exact request and response, newest
 * first, filterable by tournament, match and outcome, plus the per-tournament
 * targeting state. What an engineer reads when they ask what was sent.
 */
export async function GET(request: NextRequest) {
  return handle(() => {
    requireOrganizer(request);
    const filter = parseQuery(request, querySchema);
    return ok({ submissions: listLucraSubmissions(filter), tournaments: listTournamentLucraStatus() }, { headers: NO_STORE });
  });
}
