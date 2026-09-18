import type { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { drawRequestSchema, runDraw } from "@/server/draw";
import { handle, NO_STORE, parseBody, requireOrganizer } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/tournaments/:id/draw — generate pools and the bracket in
 * one transaction (spec §9); `?preview=1` computes without writing so the
 * organizer builder can show a live draw preview. `{ stage: "bracket" }` seeds
 * the bracket from finished pools. Organizer only.
 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/admin/tournaments/[id]/draw">) {
  return handle(async () => {
    const organizer = requireOrganizer(request);
    const { id } = await ctx.params;
    const preview = ["1", "true"].includes(request.nextUrl.searchParams.get("preview") ?? "");
    const input = await parseBody(request, drawRequestSchema);
    const outcome = runDraw(id, input, { kind: "organizer", userId: organizer.id }, { preview });
    return ok(outcome, { status: preview ? 200 : 201, headers: NO_STORE });
  });
}
