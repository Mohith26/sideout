import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCourtBoard, UNASSIGNED_COURT } from "@/db/queries/board";
import { SLUGS } from "@/seed/build";
import { createTestApp, type TestApp } from "@/test/routes";

describe("getCourtBoard", () => {
  let app: TestApp;
  beforeEach(() => {
    app = createTestApp();
  });
  afterEach(() => app.close());

  it("groups every match of the live event by court, in schedule order, and names what is on each court", () => {
    const t = app.tournament(SLUGS.live);
    const board = getCourtBoard(t.id);
    const seeded = app.data.matches.filter((m) => m.tournamentId === t.id);
    expect(board.total).toBe(seeded.length);
    expect(board.courts.reduce((n, c) => n + c.matches.length, 0)).toBe(seeded.length);
    expect(board.courts.map((c) => c.courtLabel)).toEqual(["Court 1", "Court 2", "Court 3", "Court 4", "Court 5", "Court 6"]);
    for (const court of board.courts) {
      const times = court.matches.map((m) => m.match.scheduledAt ?? 0);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(court.matches.every((m) => m.match.courtLabel === court.courtLabel)).toBe(true);
    }
    // The seeded semifinal in progress is what its court shows now; a court with only finished matches shows nothing.
    const live = seeded.find((m) => m.status === "in_progress");
    const liveCourt = board.courts.find((c) => c.courtLabel === live?.courtLabel);
    expect(liveCourt?.currentMatchId).toBe(live?.id);
    expect(board.byStatus.in_progress).toBe(1);
    expect(board.byStatus.disputed).toBe(1);
    expect(board.byStatus.awaiting_scores).toBe(1);
    expect(board.byStatus.bye).toBe(1);
    expect(board.bracketRounds).toBe(4);
    expect(board.courts.some((c) => c.courtLabel === UNASSIGNED_COURT)).toBe(false);
  });

  it("is empty before a draw exists", () => {
    const board = getCourtBoard(app.tournament(SLUGS.upcoming).id);
    expect(board).toEqual({ courts: [], bracketRounds: 0, total: 0, byStatus: {} });
  });
});
