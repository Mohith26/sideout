import type { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { handle, NO_STORE, requireUser } from "@/server/http";
import { joinTeam } from "@/server/teams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/teams/:id/join — accept the invite addressed to the signed-in user's phone (spec §9). */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/teams/[id]/join">) {
  return handle(async () => {
    const user = requireUser(request);
    const { id } = await ctx.params;
    return ok(joinTeam(id, user), { headers: NO_STORE });
  });
}
