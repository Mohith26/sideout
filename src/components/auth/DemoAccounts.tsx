"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Icons, type IconComponent } from "@/components/ui/icons";
import { Notice } from "@/components/ui/Notice";
import { MATCH_STATUS_PILL, StatusPill, TEAM_STATUS_PILL, VERIFICATION_STATE_PILL } from "@/components/ui/StatusPill";
import type { DemoAccount } from "@/db/queries/demo";
import { api } from "@/lib/api-client";
import { cx } from "@/lib/cx";
import { safeNextPath } from "@/lib/redirects";
import type { DemoAccountKey } from "@/seed/demo";

/**
 * The public demo's account picker (`DEMO_ACCOUNTS`): rendered by `/sign-in`
 * only while the switch is on, above the untouched phone form. Each card is
 * one of the curated seeded users with what they can do right now, read from
 * the rows; choosing one calls `POST /api/auth/demo` and lands where that
 * account's story starts. Every such session is marked and the shell shows
 * the "Demo" pill for it.
 */

const TITLE: Record<DemoAccountKey, string> = {
  captain_a: "Captain A",
  captain_b: "Captain B",
  registrant: "Registering captain",
  organizer: "Organizer",
  not_allowed: "Restricted player",
  demographics_missing: "Player with details to add",
};

const ICON: Record<DemoAccountKey, IconComponent> = {
  captain_a: Icons.trophy,
  captain_b: Icons.trophy,
  registrant: Icons.users,
  organizer: Icons.console,
  not_allowed: Icons.ban,
  demographics_missing: Icons.info,
};

function explain(account: DemoAccount): string {
  const d = account.detail;
  switch (d.kind) {
    case "match":
      return d.ownScorelineIn
        ? `${d.teamName}'s captain in the ${account.tournament.name} ${d.round.toLowerCase()}${d.opponentName ? ` against ${d.opponentName}` : ""}. Their scoreline is in; they can revise it or watch the other side answer.`
        : `${d.teamName}'s captain in the ${account.tournament.name} ${d.round.toLowerCase()}${d.opponentName ? ` against ${d.opponentName}` : ""}. Submits their side's scoreline: a match confirms the result, a difference opens a dispute.`;
    case "register":
      return d.teamStatus === "forming"
        ? `Captain of ${d.teamName}, a complete pair that has not entered ${account.tournament.name} yet. Walks the two registration steps: the entry donation, then the Lucra tournament entry.`
        : `Captain of ${d.teamName}, entered in ${account.tournament.name}. Shows the finished registration and the Lucra entry step.`;
    case "organizer":
      return `Runs ${account.tournament.name}: the court board, the dispute queue, the Lucra reconciliation page and the two-step close.`;
    case "lucra":
      return d.verificationState === "not_allowed"
        ? "A player Lucra has restricted. The profile shows the support path with no retry, and rewards stay out of reach."
        : "A player Lucra needs a few more details from before it can verify them. The profile walks the identity flow through the Lucra sheet.";
  }
}

function statePill(account: DemoAccount) {
  const d = account.detail;
  switch (d.kind) {
    case "match":
      return <StatusPill size="sm" spec={MATCH_STATUS_PILL[d.matchStatus]} />;
    case "register":
      return <StatusPill size="sm" spec={TEAM_STATUS_PILL[d.teamStatus]} />;
    case "lucra":
      return <StatusPill size="sm" spec={VERIFICATION_STATE_PILL[d.verificationState]} />;
    case "organizer":
      return null;
  }
}

export function DemoAccounts({ accounts, next, className }: { accounts: DemoAccount[]; next: string; className?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<DemoAccountKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(account: DemoAccount) {
    setError(null);
    setBusy(account.key);
    const result = await api<{ href: string }>("/api/auth/demo", { body: { account: account.key } });
    if (!result.ok) {
      setBusy(null);
      setError(result.error.code === "rate_limited" ? "Too many demo sign-ins from here; wait a moment and try again." : result.error.message);
      return;
    }
    // The picker's own destination wins over a generic `next` (the profile); a deep link is honoured.
    const target = next === "/me" ? safeNextPath(result.data.href, account.href) : next;
    router.replace(target);
    router.refresh();
  }

  return (
    <section aria-labelledby="demo-accounts-heading" data-testid="demo-accounts" className={cx("space-y-3", className)}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 text-text-tertiary">
          <Icons.flag size={18} />
        </span>
        <div className="min-w-0">
          <h2 id="demo-accounts-heading" className="type-heading">
            Demo accounts
          </h2>
          <p className="mt-1 text-text-secondary">This is a public demo of seeded events. Pick a role to sign in as that seeded player or organizer; no code is sent. Every demo sign-in is recorded, and the database returns to this starting point nightly.</p>
        </div>
      </div>
      {error ? (
        <Notice tone="error" title="Could not sign in">
          {error}
        </Notice>
      ) : null}
      <ul className="grid gap-2 sm:grid-cols-2">
        {accounts.map((account) => {
          const Icon = ICON[account.key];
          const pill = statePill(account);
          return (
            <li key={account.key} className="surface-raised flex min-w-0 flex-col gap-2 rounded-md p-3 md:p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-start gap-2">
                  <span className="mt-0.5 shrink-0 text-text-tertiary">
                    <Icon size={18} />
                  </span>
                  <div className="min-w-0">
                    <p className="font-medium text-text-primary">{TITLE[account.key]}</p>
                    <p className="type-label text-text-secondary">{account.displayName}</p>
                  </div>
                </div>
                {pill}
              </div>
              <p className="min-w-0 flex-1 text-text-secondary">{explain(account)}</p>
              <Button type="button" variant="secondary" className="w-full" disabled={busy !== null} aria-busy={busy === account.key} onClick={() => void choose(account)} iconEnd={<Icons.arrowRight size={16} />}>
                {busy === account.key ? "Signing in…" : `Sign in as ${account.displayName}`}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
