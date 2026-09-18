import type { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { handle, NO_STORE, requireUser } from "@/server/http";
import { entryStatusFor } from "@/server/registration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/tournaments/:slug/lucra/entry (phase 4b): the registration step's
 * second half — the verified Lucra matchup the caller's team joins through
 * the SDK, and who on the roster Lucra already lists as entered, read back
 * from Lucra's participant list rather than assumed from a join's answer
 * (§7.5: auto-join is never relied on).
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/tournaments/[slug]/lucra/entry">) {
  return handle(async () => {
    const user = requireUser(request);
    const { slug } = await ctx.params;
    return ok(await entryStatusFor(slug, user), { headers: NO_STORE });
  });
}
