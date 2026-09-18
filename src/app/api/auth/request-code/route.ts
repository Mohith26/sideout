import type { NextRequest } from "next/server";
import { z } from "zod";
import { ok } from "@/lib/api";
import { phoneSchema } from "@/lib/phone";
import { requestCode } from "@/server/auth/codes";
import { clientAddress } from "@/server/auth/rate-limit";
import { handle, NO_STORE, parseBody } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ phone: phoneSchema }).strict();

/**
 * POST /api/auth/request-code — send a one-time sign-in code to a phone.
 * Rate-limited per phone and per address. Outside production the code is
 * also returned as `devCode` so tests and local development can finish the flow.
 */
export async function POST(request: NextRequest) {
  return handle(async () => {
    const { phone } = await parseBody(request, bodySchema);
    return ok(requestCode({ phone, address: clientAddress(request) }), { headers: NO_STORE });
  });
}
