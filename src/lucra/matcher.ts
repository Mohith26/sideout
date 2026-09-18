import type { Metadata, MetadataValue } from "@/lucra/types";

/**
 * A port of Lucra's documented metadata similarity algorithm (spec §7.3, §8.3;
 * docs: legacy/7.0_user_score_by_metadata, "Metadata Matching System"). Pure:
 * no I/O, no clock. The mock resolves matchups and users through it, so the
 * strictness rules in `adapter.ts` are exercised against the real behaviour —
 * including a loose query matching several matchups.
 *
 * The prose:
 *   - `externalId` takes absolute precedence: exact match scores 1, anything
 *     else scores 0, and no other field is evaluated.
 *   - otherwise, per criteria field: exact 1.0; partial string (criteria string
 *     contained in the record string, case-insensitive) 0.5; array intersection
 *     0.7 × overlap; nested object 0.8 × nested score; numbers and booleans
 *     exact only. A record totalling at least 1.0 is returned.
 *
 * The published worked examples disagree with that prose in two places, and
 * `matcher.test.ts` records which examples reproduce under which reading:
 *   - Example 3 scores a fully-equal array as 1 (the prose gives 0.7 × 1 = 0.7,
 *     which would not even clear the threshold).
 *   - Example 5 calls "summer-league" vs "summer-tournament" a partial match at
 *     0.5, though neither string contains the other.
 *
 * `literal` implements the prose. `doc-examples` implements the smallest
 * reading under which every published example reproduces: an array equal as a
 * set is an exact match (1.0), and two strings sharing a whole token (split on
 * anything that is not a letter or digit, case-insensitive) are a partial
 * match. Which one Lucra actually runs is unknown; `LUCRA_MATCHER_INTERPRETATION`
 * selects, `literal` is the default, and `/health` reports the active one.
 */

export const MATCHER_INTERPRETATIONS = ["literal", "doc-examples"] as const;
export type MatcherInterpretation = (typeof MATCHER_INTERPRETATIONS)[number];

export const MATCH_THRESHOLD = 1;

export const WEIGHTS = {
  exact: 1,
  partialString: 0.5,
  arrayIntersection: 0.7,
  nestedObject: 0.8,
} as const;

/** The reserved field. Exact-match only, and it silences every other field. */
export const EXTERNAL_ID_KEY = "externalId";

function isPlainObject(v: MetadataValue | undefined): v is { [key: string]: MetadataValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPrimitive(v: MetadataValue | undefined): v is string | number | boolean | null {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function primitiveKey(v: string | number | boolean | null): string {
  return `${typeof v}:${String(v)}`;
}

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0),
  );
}

/** Whether two arrays hold the same primitive members (order and duplicates aside). */
function sameSet(a: readonly MetadataValue[], b: readonly MetadataValue[]): boolean {
  if (!a.every(isPrimitive) || !b.every(isPrimitive)) return false;
  const left = new Set(a.map((v) => primitiveKey(v as string | number | boolean | null)));
  const right = new Set(b.map((v) => primitiveKey(v as string | number | boolean | null)));
  if (left.size !== right.size) return false;
  for (const k of left) if (!right.has(k)) return false;
  return true;
}

/** Score one field of the criteria against the record's value for the same key. */
export function scoreField(criteria: MetadataValue, record: MetadataValue | undefined, interpretation: MatcherInterpretation): number {
  if (record === undefined) return 0;

  if (typeof criteria === "string") {
    if (typeof record !== "string") return 0;
    if (criteria === record) return WEIGHTS.exact;
    const c = criteria.toLowerCase();
    const r = record.toLowerCase();
    if (c === r) return WEIGHTS.exact;
    if (c.length > 0 && r.includes(c)) return WEIGHTS.partialString;
    if (interpretation === "doc-examples") {
      const shared = [...tokens(c)].some((t) => tokens(r).has(t));
      if (shared) return WEIGHTS.partialString;
    }
    return 0;
  }

  if (typeof criteria === "number" || typeof criteria === "boolean" || criteria === null) {
    return criteria === record ? WEIGHTS.exact : 0;
  }

  if (Array.isArray(criteria)) {
    if (!Array.isArray(record)) return 0;
    if (criteria.length === 0) return 0;
    if (interpretation === "doc-examples" && sameSet(criteria, record)) return WEIGHTS.exact;
    const recordKeys = new Set(record.filter(isPrimitive).map(primitiveKey));
    const overlap = criteria.filter((v) => isPrimitive(v) && recordKeys.has(primitiveKey(v))).length;
    // Overlap is measured against the criteria array: the documented example
    // scores criteria ["pro", "ranked"] against record ["pro"] as 1/2.
    return WEIGHTS.arrayIntersection * (overlap / criteria.length);
  }

  // Nested object: recursive, at reduced weight. The externalId rule applies inside as well.
  if (!isPlainObject(record)) return 0;
  return WEIGHTS.nestedObject * scoreMatch(criteria, record, interpretation);
}

/**
 * The similarity score of `record` for `criteria`. Only keys present in the
 * criteria count; extra record fields are ignored (documented Example 1).
 */
export function scoreMatch(criteria: Metadata, record: Metadata, interpretation: MatcherInterpretation = "literal"): number {
  if (EXTERNAL_ID_KEY in criteria) {
    return criteria[EXTERNAL_ID_KEY] === record[EXTERNAL_ID_KEY] ? WEIGHTS.exact : 0;
  }
  let total = 0;
  for (const [key, value] of Object.entries(criteria)) {
    if (value === undefined) continue;
    total += scoreField(value, record[key], interpretation);
  }
  return total;
}

export interface ScoredRecord<T> {
  record: T;
  score: number;
}

/**
 * Every record scoring at least the threshold, best first, ties in input
 * order. Lucra writes a score to *all* of these (§7.3), which is exactly why
 * Sideout only ever targets by `externalId` or `matchupId`.
 */
export function resolveMatchups<T>(criteria: Metadata, records: readonly T[], interpretation: MatcherInterpretation, metadataOf: (record: T) => Metadata): ScoredRecord<T>[] {
  const scored: ScoredRecord<T>[] = [];
  records.forEach((record) => {
    const score = scoreMatch(criteria, metadataOf(record), interpretation);
    if (score >= MATCH_THRESHOLD) scored.push({ record, score });
  });
  return scored.sort((x, y) => y.score - x.score);
}

export function parseMatcherInterpretation(raw: string | undefined): MatcherInterpretation {
  if (raw === undefined || raw.trim() === "") return "literal";
  if ((MATCHER_INTERPRETATIONS as readonly string[]).includes(raw)) return raw as MatcherInterpretation;
  throw new Error(`LUCRA_MATCHER_INTERPRETATION must be one of ${MATCHER_INTERPRETATIONS.join(", ")}; got ${JSON.stringify(raw)}`);
}
