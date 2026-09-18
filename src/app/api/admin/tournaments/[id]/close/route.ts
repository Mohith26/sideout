import type { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { closeRequestSchema, closeTournament } from "@/server/close";
import { handle, NO_STORE, parseBody, requireOrganizer } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/tournaments/:id/close — the second step of the two-step
 * confirm (spec §9, §10.7, §11.6). Requires the `previewHash` from
 * `GET …/close/preview`; refused with `close_blocked` (naming every blocking
 * match) or `preview_stale` (the standings or rewards changed) rather than
 * ever closing over something the organizer did not see. Once the close has
 * committed, Lucra settlement runs (`lucraSettlementHook`) and its outcome is
 * returned as `settlement`.
 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/admin/tournaments/[id]/close">) {
  return handle(async () => {
    const organizer = requireOrganizer(request);
    const { id } = await ctx.params;
    const { previewHash } = await parseBody(request, closeRequestSchema);
    return ok(await closeTournament({ tournamentId: id, organizerUserId: organizer.id, previewHash }), { headers: NO_STORE });
  });
}
