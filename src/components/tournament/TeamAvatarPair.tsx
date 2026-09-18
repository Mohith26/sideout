import { initials } from "@/lib/format";
import { cx } from "@/lib/cx";

/**
 * A pair of players as one team: two overlapping initials discs (or the seeded
 * avatar when one exists) and the names. Beach volleyball is played in twos,
 * so a team is always shown as its two people, never as a logo.
 */
export interface AvatarPerson {
  displayName: string;
  avatarUrl?: string | null;
}

export interface TeamAvatarPairProps {
  members: ReadonlyArray<AvatarPerson>;
  teamName?: string;
  size?: "sm" | "md";
  /** Render names beside the discs. */
  names?: boolean;
  className?: string;
}

const DISC: Record<NonNullable<TeamAvatarPairProps["size"]>, string> = {
  sm: "size-7 text-[11px]",
  md: "size-9 text-[13px]",
};

export function TeamAvatarPair({ members, teamName, size = "md", names = true, className }: TeamAvatarPairProps) {
  const pair = members.slice(0, 2);
  const label = teamName ?? pair.map((m) => m.displayName).join(" & ");
  return (
    <span className={cx("inline-flex min-w-0 items-center gap-3", className)}>
      <span className="flex shrink-0 -space-x-2" role="img" aria-label={label}>
        {pair.map((m, i) => (
          <span
            key={`${m.displayName}-${i}`}
            className={cx(
              "flex items-center justify-center rounded-full border-2 border-bg-base bg-bg-overlay font-semibold text-text-primary select-none",
              DISC[size],
              i === 1 && "bg-bg-raised",
            )}
          >
            {m.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- user-supplied avatar hosts are not known ahead of time; no optimization pipeline for them yet.
              <img src={m.avatarUrl} alt="" className="size-full rounded-full object-cover" />
            ) : (
              initials(m.displayName)
            )}
          </span>
        ))}
        {pair.length < 2 ? (
          <span className={cx("flex items-center justify-center rounded-full border-2 border-dashed border-border-strong bg-bg-inset text-text-tertiary", DISC[size])} aria-hidden="true">
            ?
          </span>
        ) : null}
      </span>
      {names ? (
        <span className="flex min-w-0 flex-col">
          {teamName ? <span className="truncate font-medium text-text-primary">{teamName}</span> : null}
          <span className={cx("truncate", teamName ? "type-label text-text-tertiary" : "font-medium text-text-primary")}>
            {pair.map((m) => m.displayName).join(" & ")}
            {pair.length < 2 ? <span className="text-text-tertiary">{pair.length ? " & partner pending" : "No players yet"}</span> : null}
          </span>
        </span>
      ) : null}
    </span>
  );
}
