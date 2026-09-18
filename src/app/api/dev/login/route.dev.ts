import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { env } from "@/env";
import { ApiFailure, ok } from "@/lib/api";
import { requestNow } from "@/lib/clock";
import { writeAudit } from "@/server/audit";
import { setSessionCookie } from "@/server/auth/session";
import { handle, NO_STORE, parseBody } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ userId: z.string().min(1) }).strict();

/**
 * POST /api/dev/login — sign in as a seeded user by id, for local development
 * and the Playwright flows (phase 5).
 *
 * This file is `route.dev.ts`: `next.config.ts` adds the `dev.ts` page
 * extension only when dev login is enabled (outside production, or with
 * `SIDEOUT_DEV_LOGIN=true`), so a normal production build has no such route at
 * all — `npm run test:bundle` asserts that over the built output. The runtime
 * guard below is defence in depth for a build that was configured otherwise.
 */
export async function POST(request: NextRequest) {
  return handle(async () => {
    if (!env.devLoginEnabled) throw new ApiFailure("not_found", "Not found.");
    const { userId } = await parseBody(request, bodySchema);
    const user = getDb().select().from(users).where(eq(users.id, userId)).get();
    if (!user) throw new ApiFailure("not_found", "No user with that id.");
    const now = requestNow();
    writeAudit(getDb(), { actor: { kind: user.role, userId: user.id }, action: "user.signed_in", subjectType: "user", subjectId: user.id, detail: { method: "dev_login" }, at: now });
    const response = ok({ user: { id: user.id, displayName: user.displayName, phoneE164: user.phoneE164, role: user.role } }, { headers: NO_STORE });
    setSessionCookie(response, user.id);
    return response;
  });
}
