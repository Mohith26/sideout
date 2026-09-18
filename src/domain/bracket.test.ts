import { describe, expect, it } from "vitest";
import { advanceWinner, BracketError, fillSlot, forfeitMatch, type BracketMatch } from "@/domain/bracket";

const AT = 1_800_000_000_000;

const match = (patch: Partial<BracketMatch> = {}): BracketMatch => ({
  id: "m1",
  round: 1,
  teamAId: "A",
  teamBId: "B",
  status: "awaiting_scores",
  winnerTeamId: null,
  nextMatchId: "m9",
  nextMatchSlot: "a",
  ...patch,
});

function errorCode(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof BracketError ? err.code : `not-a-bracket-error: ${String(err)}`;
  }
}

describe("advanceWinner", () => {
  it("resolves the match and lands the winner in the linked slot", () => {
    const out = advanceWinner(match(), "B", "final", AT);
    expect(out).toEqual({
      match: { id: "m1", status: "final", winnerTeamId: "B", finalizedAt: AT },
      next: { matchId: "m9", slot: "a", teamId: "B" },
    });
    const b = advanceWinner(match({ nextMatchSlot: "b" }), "A", "final", AT);
    expect(b.next).toEqual({ matchId: "m9", slot: "b", teamId: "A" });
  });

  it("advances nobody from a match that feeds nothing (pool play, the final)", () => {
    expect(advanceWinner(match({ nextMatchId: null, nextMatchSlot: null }), "A", "final", AT).next).toBeNull();
  });

  it("refuses a non-participant, an already resolved match, or a missing opponent", () => {
    expect(errorCode(() => advanceWinner(match(), "Z", "final", AT))).toBe("not_a_participant");
    expect(errorCode(() => advanceWinner(match({ status: "final", winnerTeamId: "A" }), "A", "final", AT))).toBe("already_resolved");
    expect(errorCode(() => advanceWinner(match({ status: "bye", teamBId: null }), "A", "final", AT))).toBe("already_resolved");
    expect(errorCode(() => advanceWinner(match({ teamBId: null, status: "scheduled" }), "A", "final", AT))).toBe("missing_opponent");
  });

  it.each(["scheduled", "in_progress", "awaiting_scores", "disputed"] as const)("can be resolved from %s", (status) => {
    expect(advanceWinner(match({ status }), "A", "forfeited", AT).match.status).toBe("forfeited");
  });
});

describe("forfeitMatch", () => {
  it("awards the match to the other side and advances them", () => {
    const out = forfeitMatch(match(), "A", AT);
    expect(out.match).toEqual({ id: "m1", status: "forfeited", winnerTeamId: "B", finalizedAt: AT });
    expect(out.next).toEqual({ matchId: "m9", slot: "a", teamId: "B" });
    expect(forfeitMatch(match(), "B", AT).match.winnerTeamId).toBe("A");
  });

  it("refuses when the forfeiting team is not playing or there is no opponent yet", () => {
    expect(errorCode(() => forfeitMatch(match(), "Z", AT))).toBe("not_a_participant");
    expect(errorCode(() => forfeitMatch(match({ teamBId: null, status: "scheduled" }), "A", AT))).toBe("missing_opponent");
    expect(errorCode(() => forfeitMatch(match({ status: "forfeited", winnerTeamId: "B" }), "A", AT))).toBe("already_resolved");
  });
});

describe("fillSlot", () => {
  it("fills an empty slot, tolerates the same team, refuses a different one", () => {
    expect(fillSlot({ id: "m9", teamAId: null, teamBId: null }, "a", "A")).toEqual({ teamAId: "A", teamBId: null });
    expect(fillSlot({ id: "m9", teamAId: "X", teamBId: null }, "b", "A")).toEqual({ teamAId: "X", teamBId: "A" });
    expect(fillSlot({ id: "m9", teamAId: "A", teamBId: null }, "a", "A")).toEqual({ teamAId: "A", teamBId: null });
    expect(errorCode(() => fillSlot({ id: "m9", teamAId: "X", teamBId: null }, "a", "A"))).toBe("slot_taken");
  });
});
