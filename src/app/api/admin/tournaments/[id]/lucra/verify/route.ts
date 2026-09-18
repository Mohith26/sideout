import type { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { handle, NO_STORE, requireOrganizer } from "@/server/http";
import { ensureMatchupTarget } from "@/server/lucra";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/tournaments/:id/lucra/verify — run the §7.3.4 assertion
 * now: the pre-write query for the tournament's `externalId` must return
 * exactly one matchup. Caches the matchup id on success, raises the blocking
 * alert otherwise. Organizers should do this before an event goes live so a
 * targeting problem never surfaces at the first consensus.
 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/admin/tournaments/[id]/lucra/verify">) {
  return handle(async () => {
    const organizer = requireOrganizer(request);
    const { id } = await ctx.params;
    return ok(await ensureMatchupTarget(id, { kind: "organizer", userId: organizer.id }, undefined, { force: true }), { headers: NO_STORE });
  });
}
