import type { ConsensusState, DonationStatus, MatchStatus, TeamStatus, TournamentStatus, VerificationState } from "@/db/schema";
import { Icons, type IconComponent } from "@/components/ui/icons";
import { cx } from "@/lib/cx";

/**
 * Status as a label plus an icon — color is never the only carrier of meaning.
 * `surf` = live/agreed, `fault` = disputes and blocks, `ember` is reserved for
 * charity and never appears here.
 */
export type PillTone = "neutral" | "live" | "attention" | "muted" | "success";

const TONE: Record<PillTone, string> = {
  neutral: "surface-raised text-text-primary",
  muted: "surface-raised text-text-secondary",
  live: "border border-surf/40 bg-surf/10 text-surf",
  success: "border border-surf/40 bg-surf/10 text-surf",
  attention: "border border-fault/40 bg-fault/10 text-fault",
};

export interface PillSpec {
  label: string;
  tone: PillTone;
  icon: IconComponent;
}

export const TOURNAMENT_STATUS_PILL: Record<TournamentStatus, PillSpec> = {
  draft: { label: "Draft", tone: "muted", icon: Icons.circleDashed },
  registration_open: { label: "Registration open", tone: "neutral", icon: Icons.users },
  registration_closed: { label: "Registration closed", tone: "muted", icon: Icons.ban },
  live: { label: "Live", tone: "live", icon: Icons.radio },
  awaiting_settlement: { label: "Awaiting settlement", tone: "attention", icon: Icons.hourglass },
  settled: { label: "Settled", tone: "muted", icon: Icons.circleCheck },
  cancelled: { label: "Cancelled", tone: "muted", icon: Icons.x },
};

export const MATCH_STATUS_PILL: Record<MatchStatus, PillSpec> = {
  scheduled: { label: "Scheduled", tone: "muted", icon: Icons.clock },
  in_progress: { label: "In progress", tone: "live", icon: Icons.activity },
  awaiting_scores: { label: "Awaiting scores", tone: "neutral", icon: Icons.hourglass },
  disputed: { label: "Disputed", tone: "attention", icon: Icons.triangleAlert },
  final: { label: "Final", tone: "muted", icon: Icons.check },
  forfeited: { label: "Forfeit", tone: "muted", icon: Icons.ban },
  bye: { label: "Bye", tone: "muted", icon: Icons.arrowRight },
};

export const CONSENSUS_STATE_PILL: Record<ConsensusState, PillSpec> = {
  awaiting_first: { label: "No scores yet", tone: "muted", icon: Icons.circleDashed },
  awaiting_second: { label: "Waiting on opponent", tone: "neutral", icon: Icons.hourglass },
  agreed: { label: "Agreed", tone: "success", icon: Icons.circleCheck },
  disputed: { label: "Disputed", tone: "attention", icon: Icons.triangleAlert },
  submitting: { label: "Submitting", tone: "neutral", icon: Icons.activity },
  accepted: { label: "Accepted", tone: "success", icon: Icons.check },
  partial: { label: "Partially accepted", tone: "attention", icon: Icons.circleAlert },
  rejected: { label: "Rejected", tone: "attention", icon: Icons.x },
};

export const VERIFICATION_STATE_PILL: Record<VerificationState, PillSpec> = {
  unverified: { label: "Not verified", tone: "muted", icon: Icons.circleDashed },
  verified: { label: "Verified", tone: "success", icon: Icons.circleCheck },
  not_allowed: { label: "Not allowed", tone: "attention", icon: Icons.ban },
  demographics_missing: { label: "Details needed", tone: "neutral", icon: Icons.info },
};

export const TEAM_STATUS_PILL: Record<TeamStatus, PillSpec> = {
  forming: { label: "Forming", tone: "neutral", icon: Icons.circleDashed },
  registered: { label: "Registered", tone: "success", icon: Icons.circleCheck },
  checked_in: { label: "Checked in", tone: "success", icon: Icons.check },
  withdrawn: { label: "Withdrawn", tone: "muted", icon: Icons.ban },
  disbanded: { label: "Disbanded", tone: "muted", icon: Icons.x },
};

/** Donation state, worded as a gift: `ember` is reserved for charity figures, so these stay on the neutral tones. */
export const DONATION_STATUS_PILL: Record<DonationStatus, PillSpec> = {
  pending: { label: "Processing", tone: "neutral", icon: Icons.hourglass },
  succeeded: { label: "Received", tone: "success", icon: Icons.circleCheck },
  refunded: { label: "Refunded", tone: "muted", icon: Icons.ban },
  failed: { label: "Failed", tone: "attention", icon: Icons.circleAlert },
};

export interface StatusPillProps {
  spec: PillSpec;
  size?: "sm" | "md";
  className?: string;
}

export function StatusPill({ spec, size = "md", className }: StatusPillProps) {
  const Icon = spec.icon;
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full whitespace-nowrap type-label",
        size === "sm" ? "h-6 px-2" : "h-7 px-2.5",
        TONE[spec.tone],
        className,
      )}
    >
      <Icon size={size === "sm" ? 12 : 14} />
      {spec.label}
    </span>
  );
}
