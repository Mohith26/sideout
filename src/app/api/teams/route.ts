import type { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { handle, NO_STORE, parseBody, requireUser } from "@/server/http";
import { createTeam, createTeamSchema } from "@/server/teams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/teams — create a team and invite a partner by phone (spec §9). */
export async function POST(request: NextRequest) {
  return handle(async () => {
    const user = requireUser(request);
    const input = await parseBody(request, createTeamSchema);
    return ok(createTeam(input, user), { status: 201, headers: NO_STORE });
  });
}
