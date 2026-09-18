import type { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { handle, NO_STORE, parseBody, requireUser } from "@/server/http";
import { mockSdkActionSchema, runMockSdkAction } from "@/server/lucra-sdk-mock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/rest/_mock/sdk — the backend of the browser stand-in for the
 * Lucra Web SDK (`src/lucra/sdk-mock.ts`). This file's `mock.ts` extension is
 * registered by `next.config.ts` only when `LUCRA_MODE=mock` at build time,
 * so a sandbox or production build has no such route at all (`npm run
 * test:bundle` proves the whole `_mock` folder is absent). Every action is
 * scoped to the signed-in Sideout account, which stands in for Lucra's own
 * session.
 */
export async function POST(request: NextRequest) {
  return handle(async () => {
    const user = requireUser(request);
    const input = await parseBody(request, mockSdkActionSchema);
    return ok(await runMockSdkAction(user, input), { headers: NO_STORE });
  });
}
