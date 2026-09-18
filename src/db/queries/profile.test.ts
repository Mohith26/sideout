import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getUserHistory } from "@/db/queries/profile";
import { SLUGS } from "@/seed/build";
import { createTestApp, type TestApp } from "@/test/routes";

describe("getUserHistory", () => {
  let app: TestApp;
  beforeEach(() => {
    app = createTestApp();
  });
  afterEach(() => app.close());

  it("derives each team's record, pool finish and bracket run from match rows", () => {
    const settled = app.tournament(SLUGS.settled);
    const finalMatch = app.data.matches.find((m) => m.tournamentId === settled.id && m.bracketPosition === 7);
    const championId = finalMatch?.winnerTeamId;
    if (!championId) throw new Error("seed has no settled final");
    const captain = app.data.teamMembers.find((m) => m.teamId === championId && m.role === "captain");
    if (!captain) throw new Error("champion has no captain");

    const history = getUserHistory(captain.userId);
    const entry = history.find((h) => h.team.id === championId);
    expect(entry).toBeDefined();
    expect(entry?.champion).toBe(true);
    expect(entry?.bracketRoundReached).toBe("Final");
    expect(entry?.poolLabel).toMatch(/^Pool [A-D]$/);
    expect(entry?.poolRank).toBeGreaterThanOrEqual(1);
    const countedRows = app.data.matches.filter((m) => (m.teamAId === championId || m.teamBId === championId) && (m.status === "final" || m.status === "forfeited"));
    expect(entry?.played).toBe(countedRows.length);
    expect(entry?.wins).toBe(countedRows.filter((m) => m.winnerTeamId === championId).length);
    expect(entry?.losses).toBe(countedRows.filter((m) => m.winnerTeamId !== championId).length);
    expect(entry?.matches.length).toBe(app.data.matches.filter((m) => m.teamAId === championId || m.teamBId === championId).length);
    for (const m of entry?.matches ?? []) {
      if (m.status !== "final") continue;
      expect(m.sets.length).toBeGreaterThan(0);
      expect(m.won).toBe(countedRows.find((r) => r.id === m.matchId)?.winnerTeamId === championId);
      // Sets are from the champion's side: a won match has more sets won than lost.
      if (m.won) expect(m.sets.filter((s) => s.mine > s.theirs).length).toBeGreaterThan(m.sets.filter((s) => s.mine < s.theirs).length);
    }
    // Every bracket match the champion played was a win.
    expect(entry?.matches.filter((m) => m.roundLabel !== "Pool round 1" && !m.roundLabel.startsWith("Pool") && m.status === "final").every((m) => m.won)).toBe(true);
    // History is newest first and every entry has its event.
    const starts = history.map((h) => h.tournament.startsAt);
    expect([...starts].sort((a, b) => b - a)).toEqual(starts);
  });

  it("reports a forming team with nothing played", () => {
    const upcoming = app.tournament(SLUGS.upcoming);
    const forming = app.data.teams.find((t) => t.tournamentId === upcoming.id && t.status === "forming");
    const member = app.data.teamMembers.find((m) => m.teamId === forming?.id);
    if (!member) throw new Error("seed has no forming team");
    const entry = getUserHistory(member.userId).find((h) => h.team.id === forming?.id);
    expect(entry).toMatchObject({ played: 0, wins: 0, losses: 0, poolLabel: null, poolRank: null, bracketRoundReached: null, champion: false, matches: [] });
    expect(entry?.donation).toBeNull();
  });

  it("is empty for a user with no teams", () => {
    expect(getUserHistory(app.organizer().id)).toEqual([]);
  });
});
