import type { ConsensusState } from "@/db/schema";
import { CONSENSUS_STATE_PILL, StatusPill } from "@/components/ui/StatusPill";
import { cx } from "@/lib/cx";

/**
 * Where the consensus stands, as a pill plus one plain sentence (spec §12.5).
 * `surf` marks agreement, `fault` marks a dispute; the wording never assigns
 * blame — a dispute is two readings that differ, not a team that lied.
 */
export interface ConsensusBadgeProps {
  state: ConsensusState | null;
  /** Names for the sentence: who has submitted, who is still to. */
  submittedBy?: string | null | undefined;
  waitingOn?: string | null | undefined;
  resolvedBy?: string | null | undefined;
  size?: "sm" | "md";
  className?: string;
}

export function consensusSentence(input: Pick<ConsensusBadgeProps, "state" | "submittedBy" | "waitingOn" | "resolvedBy">): string {
  switch (input.state) {
    case null:
    case "awaiting_first":
      return "Both teams submit the result from their own phone; it is final once the two agree.";
    case "awaiting_second":
      return input.submittedBy && input.waitingOn ? `${input.submittedBy} has submitted. Waiting on ${input.waitingOn}.` : "One team has submitted. Waiting on the other.";
    case "agreed":
      return input.resolvedBy ? `Settled by the organizer (${input.resolvedBy}).` : "Both teams submitted the same result.";
    case "disputed":
      return "The two scorelines differ. The organizer will settle it with both teams.";
    case "submitting":
      return "The agreed result is being written to Lucra.";
    case "accepted":
      return "Lucra accepted the agreed result.";
    case "partial":
      return "Lucra accepted the result only partially; the organizer will retry.";
    case "rejected":
      return "Lucra rejected the result; the organizer will retry.";
  }
}

export function ConsensusBadge({ state, submittedBy, waitingOn, resolvedBy, size = "md", className }: ConsensusBadgeProps) {
  const spec = CONSENSUS_STATE_PILL[state ?? "awaiting_first"];
  return (
    <div className={cx("flex flex-wrap items-center gap-x-3 gap-y-1", className)}>
      <StatusPill spec={spec} size={size} />
      <span className="text-text-secondary">{consensusSentence({ state, submittedBy, waitingOn, resolvedBy })}</span>
    </div>
  );
}
