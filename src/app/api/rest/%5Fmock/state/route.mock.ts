import type { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { handle, NO_STORE, requireOrganizer } from "@/server/http";
import { getLucra } from "@/server/lucra";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/rest/_mock/state (spec §8.2): the in-memory Lucra's matchups,
 * users, ingestion log and webhook queue, for assertions. This file's
 * `mock.ts` extension is registered by `next.config.ts` only when
 * `LUCRA_MODE=mock` at build time, so a sandbox or production build has no
 * such route at all (`npm run test:bundle` proves it). Organizer-gated on top.
 */
export async function GET(request: NextRequest) {
  return handle(() => {
    requireOrganizer(request);
    const mock = getLucra().mock;
    if (!mock) throw new Error("The mock state route exists only in mock mode.");
    return ok(mock.state(), { headers: NO_STORE });
  });
}
