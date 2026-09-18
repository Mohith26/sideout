import type { NextRequest } from "next/server";
import { getPoolStandings } from "@/db/queries/standings";
import { ok } from "@/lib/api";
import { handle } from "@/server/http";
import { requireTournamentBySlug } from "@/server/tournaments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/tournaments/:slug/standings — computed from `sets` rows on every
 * call and cacheable for 10 seconds (spec §9).
 */
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/tournaments/[slug]/standings">) {
  return handle(async () => {
    const { slug } = await ctx.params;
    const { tournament } = requireTournamentBySlug(slug);
    return ok(
      { tournamentId: tournament.id, slug: tournament.slug, status: tournament.status, pools: getPoolStandings(tournament.id) },
      { headers: { "Cache-Control": "public, max-age=10, s-maxage=10" } },
    );
  });
}
