"use client";

import { LucraFailureNotice } from "@/components/lucra/LucraFailureNotice";
import { useLucra } from "@/components/lucra/LucraGate";
import { ResponsiblePlayLinks } from "@/components/lucra/ResponsiblePlayLinks";
import { Button } from "@/components/ui/Button";
import { Icons } from "@/components/ui/icons";
import { cx } from "@/lib/cx";

/**
 * The wallet chip (spec §11.5, §12.5): the Lucra balance from the SDK's user
 * state when a Lucra session exists, a "Sign in with Lucra" affordance when
 * none does, and the responsible-play links directly beneath any balance
 * (§4.7). The balance is read from the SDK and never stored. Deposits and
 * withdrawals are Lucra's own flows; the direct money actions exist behind
 * `FEATURE_REAL_MONEY` (off in v1, §4.2), and Lucra's wallet screen is
 * always reachable.
 */
export interface WalletChipProps {
  policyHref: string;
  selfLimitHref: string;
  supportHref: string;
  /** `FEATURE_REAL_MONEY`: whether the add-funds and withdraw actions are offered here. */
  realMoney: boolean;
  className?: string;
}

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function WalletChip({ policyHref, selfLimitHref, supportHref, realMoney, className }: WalletChipProps) {
  const lucra = useLucra();
  const { status, user, busy, failure } = lucra;
  const signedIn = status.kind === "ready" && user !== null;
  return (
    <div className={cx("surface-raised rounded-md p-4", className)} data-testid="wallet-chip" data-state={status.kind === "ready" ? (signedIn ? "signed-in" : "signed-out") : status.kind}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="type-label text-text-tertiary">Lucra wallet</p>
          {signedIn ? (
            <p className="tabular mt-1 text-heading font-semibold text-text-primary" data-testid="wallet-balance">
              {money.format(user.balance ?? 0)}
            </p>
          ) : status.kind === "loading" ? (
            <p className="mt-1 text-text-secondary">Connecting to Lucra…</p>
          ) : status.kind === "unconfigured" ? (
            <p className="mt-1 text-text-secondary">Lucra is not configured on this deployment.</p>
          ) : status.kind === "failed" ? (
            <p className="mt-1 text-text-secondary">Lucra could not be reached.</p>
          ) : (
            <p className="mt-1 text-text-secondary">Rewards settle to your Lucra wallet. Sign in to see the balance.</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {signedIn ? (
            <>
              {realMoney ? (
                <>
                  <Button variant="secondary" disabled={busy} onClick={() => void lucra.launch("addFunds")} iconStart={<Icons.plus size={16} />}>
                    Add funds
                  </Button>
                  <Button variant="secondary" disabled={busy} onClick={() => void lucra.launch("withdraw")} iconStart={<Icons.handCoins size={16} />}>
                    Withdraw
                  </Button>
                </>
              ) : null}
              <Button variant="secondary" disabled={busy} onClick={() => void lucra.launch("wallet")}>
                Wallet
              </Button>
            </>
          ) : status.kind === "ready" ? (
            <Button variant="secondary" disabled={busy} onClick={() => void lucra.launch("auth")}>
              Sign in with Lucra
            </Button>
          ) : status.kind === "failed" ? (
            <Button variant="secondary" onClick={lucra.retry}>
              Try again
            </Button>
          ) : null}
        </div>
      </div>
      {signedIn ? <ResponsiblePlayLinks policyHref={policyHref} selfLimitHref={selfLimitHref} className="mt-3" /> : null}
      {failure ? <LucraFailureNotice failure={failure} supportHref={supportHref} className="mt-3" /> : null}
      {status.kind === "failed" ? <LucraFailureNotice failure={status.failure} supportHref={supportHref} onRetry={lucra.retry} className="mt-3" /> : null}
    </div>
  );
}
