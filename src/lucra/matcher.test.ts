import { describe, expect, it } from "vitest";
import { MATCH_THRESHOLD, MATCHER_INTERPRETATIONS, parseMatcherInterpretation, resolveMatchups, scoreMatch, type MatcherInterpretation } from "@/lucra/matcher";
import type { Metadata } from "@/lucra/types";

/**
 * The published examples (docs.lucrasports.com, legacy/7.0_user_score_by_metadata
 * §"Metadata Matching System", plus the §7.3 spec example) as a table: what
 * the docs say the result is, and what each interpretation produces. Rows
 * where an interpretation disagrees with the docs are the finding, not a bug
 * to hide: `reproduces` is asserted exactly as recorded here.
 */
interface PublishedExample {
  name: string;
  source: string;
  criteria: Metadata;
  record: Metadata;
  /** As printed in the documentation. */
  documented: { score: number; match: boolean };
  /** What each interpretation computes, and whether that equals the documented result. */
  expected: Record<MatcherInterpretation, { score: number; match: boolean; reproduces: boolean }>;
}

const EXAMPLES: PublishedExample[] = [
  {
    name: "Example 1: reserved field (externalId) silences every other field",
    source: "7.0 §4 Example 1",
    criteria: { externalId: "tournament-abc123", level: 10 },
    record: { externalId: "tournament-abc123", level: 5, region: "us-west" },
    documented: { score: 1, match: true },
    expected: {
      literal: { score: 1, match: true, reproduces: true },
      "doc-examples": { score: 1, match: true, reproduces: true },
    },
  },
  {
    name: "Example 2: exact string match",
    source: "7.0 §4 Example 2",
    criteria: { teamName: "Golden State Warriors" },
    record: { teamName: "Golden State Warriors" },
    documented: { score: 1, match: true },
    expected: {
      literal: { score: 1, match: true, reproduces: true },
      "doc-examples": { score: 1, match: true, reproduces: true },
    },
  },
  {
    name: "Example 3: fully-equal array scored as 1 (prose says 0.7 × overlap)",
    source: "7.0 §4 Example 3",
    criteria: { tags: ["competitive", "ranked", "team"] },
    record: { tags: ["competitive", "ranked", "team"] },
    documented: { score: 1, match: true },
    expected: {
      // 0.7 × 3/3 = 0.7: below the threshold, so the prose contradicts the example.
      literal: { score: 0.7, match: false, reproduces: false },
      "doc-examples": { score: 1, match: true, reproduces: true },
    },
  },
  {
    name: "Example 4: combined matching",
    source: "7.0 §4 Example 4",
    criteria: { tournament: "summer-league", skill_level: 7, tags: ["pro", "ranked"] },
    record: { tournament: "summer-league", skill_level: 7, tags: ["pro"], region: "NA" },
    documented: { score: 2.35, match: true },
    expected: {
      literal: { score: 2.35, match: true, reproduces: true },
      "doc-examples": { score: 2.35, match: true, reproduces: true },
    },
  },
  {
    name: 'Example 5: "summer-league" vs "summer-tournament" called a 0.5 partial match',
    source: "7.0 §4 Example 5",
    criteria: { tournament: "summer-league", region: "EU", skill_level: 10 },
    record: { tournament: "summer-tournament", region: "NA", skill_level: 5 },
    documented: { score: 0.5, match: false },
    expected: {
      // Neither string contains the other: the prose gives 0. The verdict (no
      // match) agrees with the docs; the printed score does not.
      literal: { score: 0, match: false, reproduces: false },
      "doc-examples": { score: 0.5, match: false, reproduces: true },
    },
  },
  {
    name: "Weight table: array intersection 2 of 3 = 0.47",
    source: "7.0 §2 weight table",
    criteria: { tags: ["a", "b", "c"] },
    record: { tags: ["a", "b", "x"] },
    documented: { score: 0.47, match: false },
    expected: {
      literal: { score: 0.47, match: false, reproduces: true },
      "doc-examples": { score: 0.47, match: false, reproduces: true },
    },
  },
];

const round2 = (n: number) => Math.round(n * 100) / 100;

describe("matcher: published examples", () => {
  for (const example of EXAMPLES) {
    for (const interpretation of MATCHER_INTERPRETATIONS) {
      const expected = example.expected[interpretation];
      it(`${example.name} [${interpretation}] → ${expected.score} (${expected.reproduces ? "reproduces" : "DOES NOT reproduce"} ${example.source})`, () => {
        const score = round2(scoreMatch(example.criteria, example.record, interpretation));
        expect(score).toBe(expected.score);
        expect(score >= MATCH_THRESHOLD).toBe(expected.match);
        const reproduces = score === example.documented.score && score >= MATCH_THRESHOLD === example.documented.match;
        expect(reproduces).toBe(expected.reproduces);
      });
    }
  }

  it("records the finding: every example reproduces under doc-examples, two do not under literal", () => {
    const failing = (i: MatcherInterpretation) => EXAMPLES.filter((e) => !e.expected[i].reproduces).map((e) => e.source);
    expect(failing("doc-examples")).toEqual([]);
    expect(failing("literal")).toEqual(["7.0 §4 Example 3", "7.0 §4 Example 5"]);
  });
});

describe("matcher: the rules themselves", () => {
  it("externalId is exact-match only and evaluates nothing else", () => {
    expect(scoreMatch({ externalId: "a" }, { externalId: "a", season: "x" })).toBe(1);
    expect(scoreMatch({ externalId: "a", season: "2026" }, { externalId: "b", season: "2026" })).toBe(0);
    expect(scoreMatch({ externalId: "A" }, { externalId: "a" })).toBe(0);
    expect(scoreMatch({ externalId: "sideout-x" }, { season: "2026" })).toBe(0);
  });

  it("partial string is containment, case-insensitive, at 0.5", () => {
    expect(scoreMatch({ venue: "pier" }, { venue: "Santa Monica Pier Courts" })).toBe(0.5);
    expect(scoreMatch({ venue: "PIER COURTS" }, { venue: "Santa Monica Pier Courts" })).toBe(0.5);
    // Containment runs one way: the criteria string inside the record string.
    expect(scoreMatch({ venue: "Santa Monica Pier Courts" }, { venue: "Pier" })).toBe(0);
    expect(scoreMatch({ venue: "" }, { venue: "Pier" })).toBe(0);
  });

  it("numbers and booleans are exact only; type mismatches score 0", () => {
    expect(scoreMatch({ level: 5 }, { level: 5 })).toBe(1);
    expect(scoreMatch({ level: 5 }, { level: "5" })).toBe(0);
    expect(scoreMatch({ ranked: true }, { ranked: true })).toBe(1);
    expect(scoreMatch({ ranked: true }, { ranked: false })).toBe(0);
    expect(scoreMatch({ level: 5 }, {})).toBe(0);
  });

  it("nested objects score at 0.8 × the nested score, recursively", () => {
    expect(scoreMatch({ venue: { city: "Hermosa Beach" } }, { venue: { city: "Hermosa Beach", state: "CA" } })).toBeCloseTo(0.8);
    expect(scoreMatch({ venue: { city: "Hermosa", state: "CA" } }, { venue: { city: "Hermosa Beach", state: "CA" } })).toBeCloseTo(0.8 * 1.5);
    expect(scoreMatch({ venue: { externalId: "v1", city: "x" } }, { venue: { externalId: "v1", city: "y" } })).toBeCloseTo(0.8);
    expect(scoreMatch({ venue: { city: "x" } }, { venue: "x" })).toBe(0);
  });

  it("array overlap is measured against the criteria array", () => {
    expect(scoreMatch({ tags: ["pro", "ranked"] }, { tags: ["pro"] })).toBeCloseTo(0.35);
    expect(scoreMatch({ tags: ["pro"] }, { tags: ["pro", "ranked"] })).toBeCloseTo(0.7);
    expect(scoreMatch({ tags: ["pro"] }, { tags: [] })).toBe(0);
    expect(scoreMatch({ tags: [] }, { tags: ["pro"] })).toBe(0);
    expect(scoreMatch({ tags: ["pro"] }, { tags: "pro" })).toBe(0);
  });

  it("under doc-examples a set-equal array is exact regardless of order", () => {
    expect(scoreMatch({ tags: ["a", "b"] }, { tags: ["b", "a"] }, "doc-examples")).toBe(1);
    expect(scoreMatch({ tags: ["a", "b"] }, { tags: ["b", "a"] }, "literal")).toBeCloseTo(0.7);
    expect(scoreMatch({ tags: ["a", "b"] }, { tags: ["a", "b", "c"] }, "doc-examples")).toBeCloseTo(0.7);
  });

  it("under doc-examples strings sharing a whole token are partial; under literal they are not", () => {
    expect(scoreMatch({ t: "summer-league" }, { t: "summer-tournament" }, "doc-examples")).toBe(0.5);
    expect(scoreMatch({ t: "summer-league" }, { t: "summer-tournament" }, "literal")).toBe(0);
    expect(scoreMatch({ t: "summer" }, { t: "summertime" }, "doc-examples")).toBe(0.5);
    expect(scoreMatch({ t: "summer" }, { t: "summertime" }, "literal")).toBe(0.5);
    expect(scoreMatch({ t: "winter-cup" }, { t: "summer-league" }, "doc-examples")).toBe(0);
  });
});

describe("resolveMatchups", () => {
  const records = [
    { id: "m1", metadata: { externalId: "sideout-a", season: "2026-spring", venue: "Sandbar" } },
    { id: "m2", metadata: { externalId: "sideout-b", season: "2026-spring", venue: "Sandbar" } },
    { id: "m3", metadata: { externalId: "sideout-c", season: "2026-spring", venue: "Pier 9" } },
    { id: "m4", metadata: { externalId: "sideout-d", season: "2025-fall", venue: "Sandbar" } },
  ];
  const meta = (r: (typeof records)[number]) => r.metadata;

  it("a loose season query returns every matchup in that season (spec §7.3's three-matchup example)", () => {
    const hits = resolveMatchups({ season: "2026-spring" }, records, "literal", meta);
    expect(hits.map((h) => h.record.id)).toEqual(["m1", "m2", "m3"]);
    expect(hits.every((h) => h.score === 1)).toBe(true);
  });

  it("an externalId query returns exactly one, and the wrong one returns none", () => {
    expect(resolveMatchups({ externalId: "sideout-b" }, records, "literal", meta).map((h) => h.record.id)).toEqual(["m2"]);
    expect(resolveMatchups({ externalId: "sideout-zzz" }, records, "literal", meta)).toEqual([]);
  });

  it("orders by score, best first, and drops anything under the threshold", () => {
    const hits = resolveMatchups({ season: "2026-spring", venue: "Sandbar" }, records, "literal", meta);
    expect(hits.map((h) => [h.record.id, h.score])).toEqual([
      ["m1", 2],
      ["m2", 2],
      ["m3", 1],
      ["m4", 1],
    ]);
    expect(resolveMatchups({ venue: "Sand" }, records, "literal", meta)).toEqual([]);
  });
});

describe("parseMatcherInterpretation", () => {
  it("defaults to literal and refuses anything unknown", () => {
    expect(parseMatcherInterpretation(undefined)).toBe("literal");
    expect(parseMatcherInterpretation("")).toBe("literal");
    expect(parseMatcherInterpretation("doc-examples")).toBe("doc-examples");
    expect(() => parseMatcherInterpretation("lenient")).toThrow(/LUCRA_MATCHER_INTERPRETATION/);
  });
});
