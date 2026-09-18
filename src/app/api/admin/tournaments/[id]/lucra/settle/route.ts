import type { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { handle, NO_STORE, requireOrganizer } from "@/server/http";
import { settleTournament } from "@/server/lucra";
import { deliverPendingMockWebhooks } from "@/server/lucra-webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/tournaments/:id/lucra/settle — settle (again) a closed
 * tournament whose Lucra settlement was refused. The close itself is the
 * two-step confirm in `POST …/close`; this only re-runs the settlement over
 * the preview frozen there.
 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/admin/tournaments/[id]/lucra/settle">) {
  return handle(async () => {
    const organizer = requireOrganizer(request);
    const { id } = await ctx.params;
    const report = await settleTournament(id, { kind: "organizer", userId: organizer.id });
    await deliverPendingMockWebhooks();
    return ok(report, { headers: NO_STORE });
  });
}
