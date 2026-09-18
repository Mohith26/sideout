import type { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { handle, NO_STORE, parseBody, requireUser } from "@/server/http";
import { registerSchema, registerTeam } from "@/server/registration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/tournaments/:slug/register — register a complete team and create
 * the charitable donation intent through the provider seam (spec §9, §11.4).
 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/tournaments/[slug]/register">) {
  return handle(async () => {
    const user = requireUser(request);
    const { slug } = await ctx.params;
    const { teamId } = await parseBody(request, registerSchema);
    return ok(registerTeam(slug, teamId, user), { status: 201, headers: NO_STORE });
  });
}
