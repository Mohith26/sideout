import type { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { handle, NO_STORE, parseBody, requireUser } from "@/server/http";
import { bindLucraAccount, bindRequestSchema } from "@/server/lucra";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/me/lucra/bind (phase 4b): after the SDK sign-in, record the Lucra
 * user id on the caller's own link — from Lucra's side (the mock's account in
 * mock mode, the participant read-back otherwise), never from the body. The
 * optional `lucraUserId` is the SDK session's id, checked against what Lucra
 * reports and refused when it disagrees. Idempotent; a link that cannot be
 * vouched for yet answers `bound: false, reason: "not_visible_yet"`.
 */
export async function POST(request: NextRequest) {
  return handle(async () => {
    const user = requireUser(request);
    const input = await parseBody(request, bindRequestSchema);
    return ok(await bindLucraAccount(user, input), { headers: NO_STORE });
  });
}
