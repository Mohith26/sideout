import type { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { handle, NO_STORE, parseBody, requireOrganizer } from "@/server/http";
import { createMockTournament, mockCreateTournamentSchema } from "@/server/lucra-mock-console";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/rest/_mock/tournaments — the organizer's stand-in for Lucra's
 * console (`src/server/lucra-mock-console.ts`): create the in-process mock's
 * tournament for an event, optionally entering the registered roster. This
 * file's `mock.ts` extension is registered by `next.config.ts` only when
 * `LUCRA_MODE=mock` at build time, so no other build has the route
 * (`npm run test:bundle`). Organizer-gated on top.
 */
export async function POST(request: NextRequest) {
  return handle(async () => {
    requireOrganizer(request);
    const input = await parseBody(request, mockCreateTournamentSchema);
    const result = await createMockTournament(input);
    return ok(result, { status: result.created ? 201 : 200, headers: NO_STORE });
  });
}
