import type { NextRequest } from "next/server";
import { z } from "zod";
import { setScoreSchema } from "@/domain/scoreline";
import { ok } from "@/lib/api";
import { resolveDispute } from "@/server/consensus";
import { handle, NO_STORE, parseBody, requireOrganizer } from "@/server/http";
import { consensusAfterWrite, writeAgreedConsensus } from "@/server/lucra";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Match-oriented: team A's points first. */
const bodySchema = z.object({ sets: z.array(setScoreSchema).min(1).max(3) }).strict();

/**
 * POST /api/admin/matches/:id/resolve — an organizer-authoritative scoreline
 * for a disputed match (spec §9, §10). Legality-checked like any submission,
 * recorded as a `score_submissions` row for no team, and attributed to the
 * organizer in `match_consensus.resolved_by_user_id` and `audit_log`. The
 * agreed result is then written to Lucra, exactly as a matching submission is.
 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/admin/matches/[id]/resolve">) {
  return handle(async () => {
    const organizer = requireOrganizer(request);
    const { id } = await ctx.params;
    const { sets } = await parseBody(request, bodySchema);
    const result = resolveDispute({ matchId: id, organizerUserId: organizer.id, sets });
    const lucra = await writeAgreedConsensus(id);
    return ok({ ...result, consensus: consensusAfterWrite(id) ?? result.consensus, lucra }, { headers: NO_STORE });
  });
}
