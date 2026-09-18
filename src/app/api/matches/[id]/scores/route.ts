import type { NextRequest } from "next/server";
import { submittedScorelineSchema } from "@/domain/consensus";
import { ok } from "@/lib/api";
import { submitScoreline } from "@/server/consensus";
import { handle, NO_STORE, parseBody, requireUser } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/matches/:id/scores — submit a scoreline for your team (spec §9,
 * §10). The body is the submitter's own points first; the server resolves
 * which team they play for, judges legality, canonicalizes and hashes, and
 * answers with where the consensus now stands: `awaiting_second`, `agreed`
 * (the match is final) or `disputed` (both scorelines are returned).
 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/matches/[id]/scores">) {
  return handle(async () => {
    const user = requireUser(request);
    const { id } = await ctx.params;
    const scoreline = await parseBody(request, submittedScorelineSchema);
    return ok(submitScoreline({ matchId: id, userId: user.id, scoreline }), { status: 201, headers: NO_STORE });
  });
}
