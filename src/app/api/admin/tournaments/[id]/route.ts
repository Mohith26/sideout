import type { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { handle, NO_STORE, parseBody, requireOrganizer } from "@/server/http";
import { updateTournament, updateTournamentSchema } from "@/server/tournaments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PATCH /api/admin/tournaments/:id — edit fields, replace sponsors, move status (spec §9). Organizer only. */
export async function PATCH(request: NextRequest, ctx: RouteContext<"/api/admin/tournaments/[id]">) {
  return handle(async () => {
    const organizer = requireOrganizer(request);
    const { id } = await ctx.params;
    const input = await parseBody(request, updateTournamentSchema);
    return ok(updateTournament(id, input, { kind: "organizer", userId: organizer.id }), { headers: NO_STORE });
  });
}
