/**
 * Display formatting. Every number on screen is derived from rows and then
 * formatted here; nothing is typed in a component.
 */

export function formatCents(cents: number, currency: string): string {
  const amount = cents / 100;
  const whole = Number.isInteger(amount);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(amount);
}

export function formatPercent(fraction: number): string {
  const pct = Math.round(Math.max(0, fraction) * 100);
  return `${pct}%`;
}

export function formatDate(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone,
  }).format(new Date(ms));
}

export function formatTime(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(ms));
}

export function formatDateRange(startMs: number, endMs: number, timeZone: string): string {
  const sameDay = formatDate(startMs, timeZone) === formatDate(endMs, timeZone);
  if (sameDay) return `${formatDate(startMs, timeZone)} · ${formatTime(startMs, timeZone)}–${formatTime(endMs, timeZone)}`;
  return `${formatDate(startMs, timeZone)} – ${formatDate(endMs, timeZone)}`;
}

/** "in 3 days", "in 5 weeks", "2 months ago" — coarse, for cards. */
export function formatRelative(targetMs: number, nowMs: number): string {
  const diff = targetMs - nowMs;
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const rtf = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
  if (abs < hour) return rtf.format(Math.round(diff / minute), "minute");
  if (abs < day) return rtf.format(Math.round(diff / hour), "hour");
  if (abs < 2 * week) return rtf.format(Math.round(diff / day), "day");
  if (abs < 8 * week) return rtf.format(Math.round(diff / week), "week");
  return rtf.format(Math.round(diff / (30 * day)), "month");
}

/** Whole-unit countdown parts for the sticky header. */
export function countdownParts(targetMs: number, nowMs: number): { days: number; hours: number; minutes: number } | null {
  const diff = targetMs - nowMs;
  if (diff <= 0) return null;
  const minutes = Math.floor(diff / 60_000);
  return { days: Math.floor(minutes / 1440), hours: Math.floor((minutes % 1440) / 60), minutes: minutes % 60 };
}

/** Initials for an avatar fallback: "Maya Delgado" -> "MD". */
export function initials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

/**
 * "Delgado / Okafor" from two display names — how beach teams are actually
 * announced. Everything after the first name is the surname, so particles
 * ("de Vries") survive.
 */
export function surname(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join(" ") : (parts[0] ?? displayName);
}

export function pairName(nameA: string, nameB: string): string {
  return `${surname(nameA)} / ${surname(nameB)}`;
}
