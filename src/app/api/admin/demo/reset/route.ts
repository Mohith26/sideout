import type { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { assertDemoResetAuthorized, resetDemoDatabase } from "@/server/demo-reset";
import { handle, NO_STORE } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/demo/reset — put the public demo's database back to the
 * seed. Bearer `DEMO_RESET_TOKEN`, not an organizer session: the nightly job
 * and the captain's one-liner (`npm run demo:reset`) call it without a
 * browser. 404 while `DEMO_ACCOUNTS` is off, 503 while no token is
 * configured, 401 for any other token, 409 while a reset is running.
 */
export async function POST(request: NextRequest) {
  return handle(async () => {
    assertDemoResetAuthorized(request.headers.get("authorization"));
    return ok(resetDemoDatabase(), { headers: NO_STORE });
  });
}
