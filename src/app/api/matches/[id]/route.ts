import type { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { handle } from "@/server/http";
import { requireMatch } from "@/server/matches";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/matches/:id (spec §9). */
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/matches/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    return ok(requireMatch(id), { headers: { "Cache-Control": "public, max-age=5" } });
  });
}
