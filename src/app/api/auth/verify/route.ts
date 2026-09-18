import type { NextRequest } from "next/server";
import { z } from "zod";
import { ok } from "@/lib/api";
import { phoneSchema } from "@/lib/phone";
import { verifyCode } from "@/server/auth/codes";
import { clientAddress } from "@/server/auth/rate-limit";
import { setSessionCookie } from "@/server/auth/session";
import { handle, NO_STORE, parseBody } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    phone: phoneSchema,
    code: z.string().trim().regex(/^\d{6}$/, "The code is six digits."),
    /** Needed only when this phone has no account yet. */
    displayName: z.string().trim().min(2).max(60).optional(),
  })
  .strict();

/** POST /api/auth/verify — exchange a code for a session cookie; creates the account on first sign-in. */
export async function POST(request: NextRequest) {
  return handle(async () => {
    const input = await parseBody(request, bodySchema);
    const { user, created } = verifyCode({ ...input, address: clientAddress(request) });
    const response = ok(
      { user: { id: user.id, displayName: user.displayName, phoneE164: user.phoneE164, role: user.role }, created },
      { status: created ? 201 : 200, headers: NO_STORE },
    );
    setSessionCookie(response, request, user.id);
    return response;
  });
}
