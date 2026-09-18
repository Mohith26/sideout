import type { NextRequest } from "next/server";
import { z } from "zod";
import { listDemoAccounts } from "@/db/queries/demo";
import { ok } from "@/lib/api";
import { clientAddress } from "@/server/auth/rate-limit";
import { assertDemoAccountsEnabled, demoSignIn } from "@/server/auth/demo";
import { setSessionCookie } from "@/server/auth/session";
import { handle, NO_STORE, parseBody } from "@/server/http";
import { DEMO_ACCOUNT_KEYS } from "@/seed/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ account: z.enum(DEMO_ACCOUNT_KEYS) }).strict();

/**
 * The public demo's account picker (`DEMO_ACCOUNTS`). Both handlers answer
 * 404 while the switch is off, so the route is indistinguishable from an
 * absent one; the phone-code sign-in (`/api/auth/request-code`, `/verify`)
 * is untouched either way.
 *
 * GET  — the curated accounts with their live state (what `/sign-in` renders).
 * POST — sign in as one of them: a normal session cookie marked `via: "demo"`,
 *        an `auth.demo_sign_in` audit row, rate-limited per address.
 */
export async function GET() {
  return handle(async () => {
    assertDemoAccountsEnabled();
    return ok({ accounts: listDemoAccounts() ?? [] }, { headers: NO_STORE });
  });
}

export async function POST(request: NextRequest) {
  return handle(async () => {
    assertDemoAccountsEnabled();
    const { account } = await parseBody(request, bodySchema);
    const signedIn = demoSignIn({ account, address: clientAddress(request) });
    const response = ok({ user: { id: signedIn.userId, displayName: signedIn.displayName, role: signedIn.role }, account: signedIn.key, href: signedIn.href, demo: true }, { headers: NO_STORE });
    setSessionCookie(response, request, signedIn.userId, undefined, { via: "demo" });
    return response;
  });
}
