import type { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { handle } from "@/server/http";
import { getPublicDetailBySlug } from "@/server/tournaments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/tournaments/:slug — detail incl. pools, bracket, standings (spec §9); drafts are 404. */
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/tournaments/[slug]">) {
  return handle(async () => {
    const { slug } = await ctx.params;
    return ok(getPublicDetailBySlug(slug), { headers: { "Cache-Control": "public, max-age=10" } });
  });
}
