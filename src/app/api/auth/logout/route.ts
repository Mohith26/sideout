import type { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { clearSessionCookie } from "@/server/auth/session";
import { handle, NO_STORE } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/auth/logout — clear the session cookie. Idempotent. */
export async function POST(_request: NextRequest) {
  return handle(() => {
    const response = ok({ signedOut: true }, { headers: NO_STORE });
    clearSessionCookie(response);
    return response;
  });
}
