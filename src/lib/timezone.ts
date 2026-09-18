/**
 * Wall-clock ↔ epoch conversion for a named IANA zone. The organizer builder
 * edits event times as the venue sees them (`<input type="datetime-local">`),
 * while the rows store epoch milliseconds; this is the seam between the two.
 *
 * `Intl` can only format an instant in a zone, not parse one, so the reverse
 * direction guesses the offset from the instant the wall clock would be at UTC,
 * then corrects once. Two passes are exact everywhere except inside a DST gap,
 * where the wall time does not exist and the later instant is returned.
 */

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/;

/** Parse the value of a `datetime-local` input; null when it is not one. */
export function parseWallClock(value: string): WallClock | null {
  const m = WALL_RE.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const wall = { year: Number(y), month: Number(mo), day: Number(d), hour: Number(h), minute: Number(mi) };
  if (wall.month < 1 || wall.month > 12 || wall.day < 1 || wall.day > 31 || wall.hour > 23 || wall.minute > 59) return null;
  return wall;
}

export function wallClockAt(ms: number, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

/** Zone offset in milliseconds at `ms` (positive east of UTC). */
export function zoneOffsetAt(ms: number, timeZone: string): number {
  const w = wallClockAt(ms, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  return asUtc - Math.floor(ms / 60_000) * 60_000;
}

export function wallClockToEpoch(wall: WallClock, timeZone: string): number {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const first = naive - zoneOffsetAt(naive, timeZone);
  const second = naive - zoneOffsetAt(first, timeZone);
  if (second === first) return second;
  const check = wallClockAt(second, timeZone);
  const reproduces = check.year === wall.year && check.month === wall.month && check.day === wall.day && check.hour === wall.hour && check.minute === wall.minute;
  // No instant has this wall time (a DST gap): the two guesses straddle the transition; take the later one.
  return reproduces ? second : Math.max(first, second);
}

/** "2026-09-17T08:00", the value a `datetime-local` input wants, for `ms` as the zone sees it. */
export function formatWallClock(ms: number, timeZone: string): string {
  const w = wallClockAt(ms, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}
