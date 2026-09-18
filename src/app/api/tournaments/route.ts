import type { NextRequest } from "next/server";
import { z } from "zod";
import { listTournamentSummaries } from "@/db/queries/tournaments";
import { TOURNAMENT_STATUSES } from "@/db/schema";
import { ok } from "@/lib/api";
import { handle, parseQuery } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  /** Comma-separated statuses, e.g. `?status=live,registration_open`. */
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(TOURNAMENT_STATUSES)).optional()),
});

/** GET /api/tournaments — list, filterable by status (spec §9). */
export async function GET(request: NextRequest) {
  return handle(() => {
    const { status } = parseQuery(request, querySchema);
    return ok(listTournamentSummaries(status), { headers: { "Cache-Control": "public, max-age=10" } });
  });
}
