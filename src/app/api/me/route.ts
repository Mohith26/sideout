import type { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { handle, NO_STORE, requireUser } from "@/server/http";
import { getProfile } from "@/server/me";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/me — profile, Lucra link state, teams and history, invites, rewards (spec §9). */
export async function GET(request: NextRequest) {
  return handle(() => {
    const user = requireUser(request);
    return ok(getProfile(user), { headers: NO_STORE });
  });
}
