"use client";

import { useLucra } from "@/components/lucra/LucraGate";
import { Button } from "@/components/ui/Button";
import { Icons, type IconComponent } from "@/components/ui/icons";
import type { VerificationState } from "@/db/schema";
import { cx } from "@/lib/cx";
import { BLOCKED_ACCOUNT_STATUSES, VERIFIED_ACCOUNT_STATUSES, type SdkUser } from "@/lucra/sdk-surface";

/**
 * The profile's identity row (spec §11.5): a calm status line, one action at
 * most, and — for `not_allowed` — a plain terminal explanation with a
 * support path and no retry. The state comes from `lucra_links.
 * verification_state` (the only identity fact Sideout stores, §4.6); a live
 * Lucra session refines it, since a `BLOCKED` account or a fresh
 * verification is known to the SDK before any webhook lands.
 */
export interface VerificationRowProps {
  /** `null` when the player has never signed in to Lucra. */
  state: VerificationState | null;
  supportHref: string;
  className?: string;
}

/** What the SDK's session says, when it says anything, wins over the stored enum. */
export function effectiveVerificationState(stored: VerificationState | null, user: SdkUser | null): VerificationState | null {
  const status = user?.accountStatus;
  if (status && BLOCKED_ACCOUNT_STATUSES.has(status)) return "not_allowed";
  if (status && VERIFIED_ACCOUNT_STATUSES.has(status)) return "verified";
  return stored;
}

interface RowSpec {
  icon: IconComponent;
  iconClass: string;
  title: string;
  body: string;
  action: { flow: "identity" | "demographics" | "auth"; label: string } | null;
}

function specFor(state: VerificationState | null, signedIn: boolean): RowSpec {
  switch (state) {
    case "verified":
      return { icon: Icons.circleCheck, iconClass: "text-surf", title: "Verified with Lucra", body: "Age and location confirmed by Lucra. Nothing from the form is stored here.", action: null };
    case "not_allowed":
      return {
        icon: Icons.ban,
        iconClass: "text-fault",
        title: "Lucra can't offer play to this account",
        body: "Lucra has restricted this account under its own rules, which Sideout cannot see or change. Your donations and your team are unaffected. Lucra support can explain and help; there is nothing to retry here.",
        action: null,
      };
    case "demographics_missing":
      return { icon: Icons.info, iconClass: "text-text-secondary", title: "Lucra needs a few details", body: "Free-to-play tournaments need a short demographic form. Lucra collects it; Sideout never sees it.", action: { flow: "demographics", label: "Complete Lucra's form" } };
    case "unverified":
    case null:
      return {
        icon: Icons.circleDashed,
        iconClass: "text-text-tertiary",
        title: signedIn ? "Not verified yet" : "Not verified",
        body: "Lucra confirms age and location through its own identity form before you can enter a tournament. Sideout stores only the outcome.",
        action: { flow: "identity", label: "Verify with Lucra" },
      };
  }
}

export function VerificationRow({ state, supportHref, className }: VerificationRowProps) {
  const lucra = useLucra();
  const signedIn = lucra.status.kind === "ready" && lucra.user !== null;
  const effective = effectiveVerificationState(state, lucra.user);
  const spec = specFor(effective, signedIn);
  const Icon = spec.icon;
  const unavailable = lucra.status.kind === "unconfigured";
  return (
    <div className={cx("surface-raised flex items-start gap-3 rounded-md p-4", className)} data-testid="verification-row" data-state={effective ?? "none"}>
      <span className={cx("mt-0.5 shrink-0", spec.iconClass)}>
        <Icon size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-text-primary">{spec.title}</p>
        <p className="mt-0.5 text-text-secondary">{spec.body}</p>
        {effective === "not_allowed" ? (
          <a href={supportHref} target="_blank" rel="noreferrer noopener" className="target mt-2 inline-flex items-center gap-1.5 font-medium text-text-primary hover:text-volt">
            <Icons.externalLink size={14} />
            Contact Lucra support
          </a>
        ) : null}
        {spec.action && !unavailable ? (
          <div className="mt-3">
            <Button variant="secondary" disabled={lucra.busy || lucra.status.kind === "loading"} onClick={() => void lucra.launch(spec.action?.flow ?? "identity")}>
              {spec.action.label}
            </Button>
          </div>
        ) : null}
        {spec.action && unavailable ? <p className="mt-2 type-label text-text-tertiary">Lucra is not configured on this deployment</p> : null}
      </div>
    </div>
  );
}
