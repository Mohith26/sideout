import type { NextRequest } from "next/server";
import { submittedScorelineSchema } from "@/domain/consensus";
import { ok } from "@/lib/api";
import { submitScoreline } from "@/server/consensus";
import { handle, NO_STORE, parseBody, requireUser } from "@/server/http";
import { consensusAfterWrite, writeAgreedConsensus } from "@/server/lucra";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/matches/:id/scores — submit a scoreline for your team (spec §9,
 * §10). The body is the submitter's own points first; the server resolves
 * which team they play for, judges legality, canonicalizes and hashes, and
 * answers with where the consensus now stands: `awaiting_second`, `agreed`
 * (the match is final) or `disputed` (both scorelines are returned).
 *
 * An `agreed` result is written to Lucra once the consensus transaction has
 * committed (spec §10: `agreed → submitting → accepted | partial | rejected`);
 * the outcome rides along as `lucra` and the returned consensus view reflects
 * it. A Lucra problem never unwinds the recorded result.
 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/matches/[id]/scores">) {
  return handle(async () => {
    const user = requireUser(request);
    const { id } = await ctx.params;
    const scoreline = await parseBody(request, submittedScorelineSchema);
    const result = submitScoreline({ matchId: id, userId: user.id, scoreline });
    if (result.outcome !== "agreed") return ok({ ...result, lucra: null }, { status: 201, headers: NO_STORE });
    const lucra = await writeAgreedConsensus(id);
    return ok({ ...result, consensus: consensusAfterWrite(id) ?? result.consensus, lucra }, { status: 201, headers: NO_STORE });
  });
}
