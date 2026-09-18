import { initials } from "@/lib/format";
import { cx } from "@/lib/cx";

/**
 * A pair of players as one team: two overlapping initials discs and the names.
 * Beach volleyball is played in twos, so a team is always shown as its two
 * people, never as a logo.
 */
export interface AvatarPerson {
  displayName: string;
}

export interface TeamAvatarPairProps {
  members: ReadonlyArray<AvatarPerson>;
  teamName?: string;
  className?: string;
}

const DISC = "size-9 text-[13px]";

export function TeamAvatarPair({ members, teamName, className }: TeamAvatarPairProps) {
  const pair = members.slice(0, 2);
  const label = teamName ?? pair.map((m) => m.displayName).join(" & ");
  return (
    <span className={cx("inline-flex min-w-0 items-center gap-3", className)}>
      <span className="flex shrink-0 -space-x-2" role="img" aria-label={label}>
        {pair.map((m, i) => (
          <span
            key={`${m.displayName}-${i}`}
            className={cx("flex items-center justify-center rounded-full border-2 border-bg-base bg-bg-overlay font-semibold text-text-primary select-none", DISC, i === 1 && "bg-bg-raised")}
          >
            {initials(m.displayName)}
          </span>
        ))}
        {pair.length < 2 ? (
          <span className={cx("flex items-center justify-center rounded-full border-2 border-dashed border-border-strong bg-bg-inset text-text-tertiary", DISC)} aria-hidden="true">
            ?
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 flex-col">
        {teamName ? <span className="truncate font-medium text-text-primary">{teamName}</span> : null}
        <span className={cx("truncate", teamName ? "type-label text-text-tertiary" : "font-medium text-text-primary")}>
          {pair.map((m) => m.displayName).join(" & ")}
          {pair.length < 2 ? <span className="text-text-tertiary">{pair.length ? " & partner pending" : "No players yet"}</span> : null}
        </span>
      </span>
    </span>
  );
}
