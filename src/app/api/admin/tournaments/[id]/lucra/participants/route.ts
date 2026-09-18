import type { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { handle, NO_STORE, requireOrganizer } from "@/server/http";
import { reconcileParticipants } from "@/server/lucra";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/tournaments/:id/lucra/participants (spec §7.5): the
 * matchup's participant list read back from Lucra and reconciled against
 * `teams` — matched, missing (registered but not in Lucra), unlinked, and
 * extra (in Lucra but on no team). Auto-join is never relied on.
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/admin/tournaments/[id]/lucra/participants">) {
  return handle(async () => {
    const organizer = requireOrganizer(request);
    const { id } = await ctx.params;
    return ok(await reconcileParticipants(id, { kind: "organizer", userId: organizer.id }), { headers: NO_STORE });
  });
}
