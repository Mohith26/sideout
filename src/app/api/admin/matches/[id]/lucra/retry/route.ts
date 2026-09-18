import type { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { handle, NO_STORE, requireOrganizer } from "@/server/http";
import { retryConsensusScores } from "@/server/lucra";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/matches/:id/lucra/retry — the organizer's retry of a
 * `rejected` or `partial` Lucra write (spec §10's `organizer_retry` edges).
 * The same request goes out under the same idempotency key as the next
 * attempt; anything else is refused by `assertMayRetryLucraWrite`.
 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/admin/matches/[id]/lucra/retry">) {
  return handle(async () => {
    const organizer = requireOrganizer(request);
    const { id } = await ctx.params;
    return ok(await retryConsensusScores(id, organizer.id), { headers: NO_STORE });
  });
}
