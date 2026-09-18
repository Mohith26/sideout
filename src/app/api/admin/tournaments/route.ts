import type { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { handle, NO_STORE, parseBody, requireOrganizer } from "@/server/http";
import { createTournament, createTournamentSchema } from "@/server/tournaments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/admin/tournaments — create an event in `draft` (spec §9). Organizer only. */
export async function POST(request: NextRequest) {
  return handle(async () => {
    const organizer = requireOrganizer(request);
    const input = await parseBody(request, createTournamentSchema);
    return ok(createTournament(input, { kind: "organizer", userId: organizer.id }), { status: 201, headers: NO_STORE });
  });
}
