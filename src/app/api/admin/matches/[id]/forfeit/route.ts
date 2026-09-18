import type { NextRequest } from "next/server";
import { z } from "zod";
import { ok } from "@/lib/api";
import { handle, NO_STORE, parseBody, requireOrganizer } from "@/server/http";
import { forfeitMatch } from "@/server/matches";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ teamId: z.string().min(1) }).strict();

/**
 * POST /api/admin/matches/:id/forfeit — the named team forfeits; the opponent
 * advances through `@/domain/bracket`. Not in spec §9's list: it is the one
 * bracket-advancing action that exists before the consensus phase.
 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/admin/matches/[id]/forfeit">) {
  return handle(async () => {
    const organizer = requireOrganizer(request);
    const { id } = await ctx.params;
    const { teamId } = await parseBody(request, bodySchema);
    return ok(forfeitMatch(id, teamId, { kind: "organizer", userId: organizer.id }), { headers: NO_STORE });
  });
}
