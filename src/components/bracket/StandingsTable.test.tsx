// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StandingsFootnote, StandingsTable, tiebreakFootnote } from "@/components/bracket/StandingsTable";
import { computeStandings, TIEBREAK_ORDER } from "@/domain/standings";

afterEach(cleanup);

const teams = [
  { id: "a", name: "Delgado / Okafor", seed: 1, members: [{ displayName: "Maya Delgado" }, { displayName: "Sam Okafor" }] },
  { id: "b", name: "Raman / Whitfield", seed: null, members: [{ displayName: "Priya Raman" }, { displayName: "Cole Whitfield" }] },
  { id: "c", name: "Ito / Bauer", seed: null, members: [] },
];

describe("StandingsTable", () => {
  it("renders rank, team, W–L, sets and point differential from computed rows with stable row ids", () => {
    const rows = computeStandings(
      ["a", "b", "c"],
      [
        { teamAId: "a", teamBId: "b", winnerTeamId: "a", sets: [{ teamAPoints: 21, teamBPoints: 18 }] },
        { teamAId: "c", teamBId: "b", winnerTeamId: "b", sets: [{ teamAPoints: 15, teamBPoints: 21 }] },
        { teamAId: "a", teamBId: "c", winnerTeamId: "a", sets: [{ teamAPoints: 21, teamBPoints: 10 }] },
      ],
    );
    render(<StandingsTable label="Pool A" courtLabel="Court 2" rows={rows} teams={teams} played={3} total={3} highlightTeamId="b" />);
    const table = screen.getByRole("table", { name: /Pool A standings/ });
    const body = within(table).getAllByRole("row").slice(1);
    expect(body.map((r) => r.getAttribute("data-team-id"))).toEqual(["a", "b", "c"]);
    expect(body.map((r) => r.getAttribute("data-rank"))).toEqual(["1", "2", "3"]);
    const cells = (row: HTMLElement) => within(row).getAllByRole("cell").map((c) => c.textContent);
    expect(cells(body[0] as HTMLElement).slice(0, 5)).toEqual(["1", "1Delgado / OkaforMaya Delgado & Sam Okafor", "2–0", "2–0", "+14"]);
    expect(cells(body[1] as HTMLElement).slice(0, 5)).toEqual(["2", "Raman / WhitfieldPriya Raman & Cole Whitfield", "1–1", "1–1", "+3"]);
    expect(cells(body[2] as HTMLElement).slice(0, 5)).toEqual(["3", "Ito / Bauer", "0–2", "0–2", "−17"]);
    expect(body[1]?.className).toContain("bg-bg-overlay");
    expect(screen.getByText("Court 2 · 3 of 3 played")).toBeInTheDocument();
  });

  it("explains the tiebreak order in the domain's sequence", () => {
    render(<StandingsFootnote />);
    const note = screen.getByText(/Ties break in order/);
    expect(note.textContent).toContain("1. match wins · 2. head-to-head (two-way ties) · 3. set ratio · 4. point differential · 5. points scored · 6. entry order");
    expect(tiebreakFootnote().split(" · ")).toHaveLength(TIEBREAK_ORDER.length);
  });
});
