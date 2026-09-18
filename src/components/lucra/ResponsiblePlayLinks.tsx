"use client";

import { useLucraOptional } from "@/components/lucra/LucraGate";
import { Icons } from "@/components/ui/icons";
import { cx } from "@/lib/cx";

/**
 * Spec §4.7: Lucra's responsible gaming policy and self-limit tooling,
 * directly beneath any wallet balance. The URLs come from config
 * (`LUCRA_RESPONSIBLE_GAMING_URL`, `LUCRA_SELF_LIMIT_URL`), passed down from
 * the server page; the in-app self-control screen is Lucra's own profile
 * flow, offered when a Lucra session exists.
 */
export interface ResponsiblePlayLinksProps {
  policyHref: string;
  selfLimitHref: string;
  className?: string;
}

export function ResponsiblePlayLinks({ policyHref, selfLimitHref, className }: ResponsiblePlayLinksProps) {
  const lucra = useLucraOptional();
  const signedIn = lucra?.status.kind === "ready" && lucra.user !== null;
  const linkClass = "target inline-flex items-center gap-1.5 type-label text-text-secondary hover:text-text-primary";
  return (
    <nav aria-label="Responsible play" className={cx("flex flex-wrap items-center gap-x-4 gap-y-1", className)} data-testid="responsible-play">
      <a href={policyHref} target="_blank" rel="noreferrer noopener" className={linkClass}>
        <Icons.shieldCheck size={14} />
        Responsible gaming policy
        <Icons.externalLink size={12} />
      </a>
      {signedIn ? (
        <button type="button" className={linkClass} disabled={lucra.busy} onClick={() => void lucra.launch("profile")}>
          <Icons.lock size={14} />
          Set limits in Lucra
        </button>
      ) : (
        <a href={selfLimitHref} target="_blank" rel="noreferrer noopener" className={linkClass}>
          <Icons.lock size={14} />
          Limits and self-exclusion
          <Icons.externalLink size={12} />
        </a>
      )}
    </nav>
  );
}
