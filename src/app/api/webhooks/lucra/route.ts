import type { NextRequest } from "next/server";
import { fail, ok } from "@/lib/api";
import { LUCRA_SIGNATURE_HEADER } from "@/lucra";
import { handle, NO_STORE } from "@/server/http";
import { receiveLucraWebhook } from "@/server/lucra-webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/lucra (spec §7.6). The raw body is read before anything
 * parses it; verification, deduplication, persistence and processing live in
 * `@/server/lucra-webhooks`. The response never carries a secret or the
 * expected digest — only what happened to the delivery.
 */
export async function POST(request: NextRequest) {
  return handle(async () => {
    const rawBody = await request.text();
    const receipt = await receiveLucraWebhook({ rawBody, signatureHeader: request.headers.get(LUCRA_SIGNATURE_HEADER) });
    const data = { eventId: receipt.eventId, eventType: receipt.eventType, duplicate: receipt.duplicate, processingState: receipt.processingState, message: receipt.message };
    if (receipt.status === 401) return fail("unauthorized", receipt.message, data, { headers: NO_STORE });
    if (receipt.status === 400) return fail("bad_request", receipt.message, data, { headers: NO_STORE });
    if (receipt.status >= 500) return fail("internal", receipt.message, data, { headers: NO_STORE });
    return ok(data, { headers: NO_STORE });
  });
}
