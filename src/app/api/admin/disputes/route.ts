import type { NextRequest } from "next/server";
import { z } from "zod";
import { listDisputes } from "@/db/queries/consensus";
import { ok } from "@/lib/api";
import { handle, NO_STORE, parseQuery, requireOrganizer } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({ tournamentId: z.string().min(1).optional() });

/**
 * GET /api/admin/disputes[?tournamentId=] — every open dispute (the match
 * and its consensus both `disputed`; `listDisputes` says why both), with both
 * scorelines and the sets on which they differ (spec §9). Organizer only.
 */
export async function GET(request: NextRequest) {
  return handle(() => {
    requireOrganizer(request);
    const { tournamentId } = parseQuery(request, querySchema);
    return ok({ disputes: listDisputes(tournamentId) }, { headers: NO_STORE });
  });
}
