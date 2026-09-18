import type { NextRequest } from "next/server";
import { getDb } from "@/db/client";
import { getTournamentImpact } from "@/db/queries/impact";
import { ok } from "@/lib/api";
import { requestNow } from "@/lib/clock";
import { settleDueDonations } from "@/server/donations/stub-provider";
import { handle } from "@/server/http";
import { requireTournamentBySlug } from "@/server/tournaments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/tournaments/:slug/impact — donation totals and goal progress (spec §9). */
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/tournaments/[slug]/impact">) {
  return handle(async () => {
    const { slug } = await ctx.params;
    const { tournament, charity } = requireTournamentBySlug(slug);
    settleDueDonations(getDb(), requestNow());
    const impact = getTournamentImpact(tournament);
    return ok({ tournamentId: tournament.id, slug: tournament.slug, charity, ...impact }, { headers: { "Cache-Control": "public, max-age=10" } });
  });
}
