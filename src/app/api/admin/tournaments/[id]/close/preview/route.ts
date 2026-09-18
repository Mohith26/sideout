import type { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { previewClose } from "@/server/close";
import { handle, NO_STORE, requireOrganizer } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/tournaments/:id/close/preview — the frozen preview an
 * organizer confirms before closing (spec §11.6): final standings, projected
 * rewards, the list of anything still blocking, and the hash `POST …/close`
 * requires.
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/admin/tournaments/[id]/close/preview">) {
  return handle(async () => {
    requireOrganizer(request);
    const { id } = await ctx.params;
    return ok(previewClose(id), { headers: NO_STORE });
  });
}
