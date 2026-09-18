import type { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { handle, NO_STORE, parseBody, requireUser } from "@/server/http";
import { linkLucraAccount, linkRequestSchema } from "@/server/lucra";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/me/lucra/link (spec §9): mint the stable opaque `external_id`
 * for the signed-in player (once), and record the Lucra user id the SDK
 * sign-in reports (phase 4b sends it). Idempotent: calling again returns the
 * same external id. Never the phone or the email.
 */
export async function POST(request: NextRequest) {
  return handle(async () => {
    const user = requireUser(request);
    const body = await parseBody(request, linkRequestSchema);
    const result = linkLucraAccount(user, body);
    return ok(result, { status: result.minted ? 201 : 200, headers: NO_STORE });
  });
}
