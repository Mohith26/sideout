import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import { getDb } from "@/db/client";
import { donations, type DonationProvider } from "@/db/schema";
import type { Db } from "@/db/connection";
import { writeAudit, SYSTEM_ACTOR } from "@/server/audit";

/**
 * Charitable donation provider seam (spec §6.4, §11.4). Registration creates a
 * donation *intent* here; the provider decides when it becomes `succeeded`.
 *
 * `stub` — the default and the only provider in this build — accepts every
 * intent as `pending` and marks it `succeeded` once `STUB_SETTLE_DELAY_MS`
 * has passed on the injected clock. `settleDueDonations` is the sweep that
 * applies that rule; the registration, impact and profile paths call it before
 * reading (routes and pages through `sweepDueDonations`, which owns the
 * connection), so a pending donation flips on the next read after the delay
 * with no timers and no wall-clock dependence in tests.
 *
 * A real provider (Stripe is the enum's other value) replaces `createIntent`
 * with a PaymentIntent and `settleDueDonations` with a webhook handler, and
 * nothing outside this module changes. No card data is ever handled here.
 */

export const STUB_SETTLE_DELAY_MS = 60_000;

export interface DonationIntent {
  provider: DonationProvider;
  providerRef: string;
  status: "pending";
}

export interface DonationProviderAdapter {
  createIntent(input: { amountCents: number; currency: string }): DonationIntent;
}

export const stubDonationProvider: DonationProviderAdapter = {
  createIntent() {
    return { provider: "stub", providerRef: `stub_${randomBytes(8).toString("hex")}`, status: "pending" };
  },
};

export function getDonationProvider(): DonationProviderAdapter {
  return stubDonationProvider;
}

/** The sweep on the process connection, for a route or page that reads impact figures. */
export function sweepDueDonations(nowMs: number): number {
  return settleDueDonations(getDb(), nowMs);
}

/** Flip every stub donation whose delay has elapsed to `succeeded`. Returns how many changed. */
export function settleDueDonations(db: Db, nowMs: number): number {
  const due = db
    .select({ id: donations.id, tournamentId: donations.tournamentId, amountCents: donations.amountCents })
    .from(donations)
    .where(and(eq(donations.provider, "stub"), eq(donations.status, "pending"), lte(donations.createdAt, nowMs - STUB_SETTLE_DELAY_MS)))
    .all();
  if (due.length === 0) return 0;
  db.transaction((tx) => {
    for (const row of due) {
      tx.update(donations).set({ status: "succeeded" }).where(and(eq(donations.id, row.id), eq(donations.status, "pending"))).run();
      writeAudit(tx, {
        actor: SYSTEM_ACTOR,
        action: "donation.succeeded",
        subjectType: "donation",
        subjectId: row.id,
        detail: { provider: "stub", tournamentId: row.tournamentId, amountCents: row.amountCents },
        at: nowMs,
      });
    }
  });
  return due.length;
}
