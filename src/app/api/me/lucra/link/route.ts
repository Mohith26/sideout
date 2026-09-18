import type { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { handle, NO_STORE, parseBody, requireUser } from "@/server/http";
import { linkLucraAccount, linkRequestSchema } from "@/server/lucra";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/me/lucra/link (spec §9): mint the stable opaque `external_id`
 * for the signed-in player (once). Idempotent: calling again returns the same
 * external id. Never the phone or the email, and never a Lucra user id from
 * the caller — that is learned from Lucra's participant list and webhooks.
 * The body must be an empty JSON object.
 */
export async function POST(request: NextRequest) {
  return handle(async () => {
    const user = requireUser(request);
    await parseBody(request, linkRequestSchema);
    const result = linkLucraAccount(user);
    return ok(result, { status: result.minted ? 201 : 200, headers: NO_STORE });
  });
}
