import { describe, expect, it } from "vitest";
import { canonicalizeScoreline, hashScoreline } from "@/domain/scoreline-hash";

describe("canonical scoreline hash", () => {
  const matchId = "01900000-0000-7000-8000-000000000001";
  const fromA = {
    matchId,
    sets: [
      { setNumber: 2, teamAPoints: 19, teamBPoints: 21 },
      { setNumber: 1, teamAPoints: 21, teamBPoints: 18 },
      { setNumber: 3, teamAPoints: 15, teamBPoints: 12 },
    ],
  };
  // Team B typed the same match from their side: their points first.
  const fromB = {
    matchId,
    sets: [
      { setNumber: 1, teamAPoints: 18, teamBPoints: 21 },
      { setNumber: 2, teamAPoints: 21, teamBPoints: 19 },
      { setNumber: 3, teamAPoints: 12, teamBPoints: 15 },
    ],
  };

  it("orders sets and normalizes orientation", () => {
    expect(canonicalizeScoreline(fromA, "a")).toBe(`{"matchId":"${matchId}","sets":[[1,21,18],[2,19,21],[3,15,12]]}`);
    expect(canonicalizeScoreline(fromB, "b")).toBe(canonicalizeScoreline(fromA, "a"));
  });

  it("agreement is hash equality; a one-point difference is a different hash", () => {
    expect(hashScoreline(fromA, "a")).toBe(hashScoreline(fromB, "b"));
    expect(hashScoreline(fromA, "a")).toMatch(/^[0-9a-f]{64}$/);
    const differs = { ...fromA, sets: fromA.sets.map((s) => (s.setNumber === 3 ? { ...s, teamBPoints: 13 } : s)) };
    expect(hashScoreline(differs, "a")).not.toBe(hashScoreline(fromA, "a"));
  });

  it("refuses malformed input rather than hashing garbage", () => {
    expect(() => hashScoreline({ matchId: "", sets: [] })).toThrow();
    expect(() => hashScoreline({ matchId, sets: [{ setNumber: 1, teamAPoints: -1, teamBPoints: 21 }] })).toThrow();
  });
});
