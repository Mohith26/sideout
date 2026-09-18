// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PoolTable, type PoolMatchRef, type PoolTeamRef } from "@/components/bracket/PoolTable";
import { computeStandings } from "@/domain/standings";

afterEach(cleanup);

const TZ = "America/Los_Angeles";

const teams: PoolTeamRef[] = [
  { id: "a", name: "Delgado / Okafor", seed: 1, members: [{ displayName: "Maya Delgado" }, { displayName: "Sam Okafor" }] },
  { id: "b", name: "Raman / Whitfield", seed: null, members: [{ displayName: "Priya Raman" }, { displayName: "Cole Whitfield" }] },
  { id: "c", name: "Ito / Bauer", seed: null, members: [{ displayName: "Ken Ito" }, { displayName: "Lena Bauer" }] },
];

const match = (id: string, a: string, b: string, extra: Partial<PoolMatchRef>): PoolMatchRef => ({
  id,
  teamAId: a,
  teamBId: b,
  status: "scheduled",
  winnerId: null,
  sets: [],
  round: 1,
  scheduledAt: Date.UTC(2026, 8, 17, 15, 30),
  href: `/m/${id}`,
  ...extra,
});

const matches: PoolMatchRef[] = [
  match("m1", "a", "b", { status: "final", winnerId: "a", sets: [{ a: 21, b: 18 }] }),
  match("m2", "b", "c", { status: "forfeited", winnerId: "c" }),
  match("m3", "a", "c", { status: "in_progress", sets: [{ a: 21, b: 19 }, { a: 7, b: 9 }] }),
];

describe("PoolTable", () => {
  it("renders the sheet: teams by rank, each meeting as a result cell that links to the match, and the record", () => {
    const standings = computeStandings(
      ["a", "b", "c"],
      [
        { teamAId: "a", teamBId: "b", winnerTeamId: "a", sets: [{ teamAPoints: 21, teamBPoints: 18 }] },
        { teamAId: "b", teamBId: "c", winnerTeamId: "c", sets: [] },
      ],
    );
    render(<PoolTable label="Pool A" courtLabel="Court 3" teams={teams} matches={matches} standings={standings} timeZone={TZ} />);
    const table = screen.getByRole("table", { name: /Pool A results/ });
    const rows = within(table).getAllByRole("row").slice(1);
    // a (1–0, +3) ranks first, c (1–0 by forfeit, no sets) second, b last.
    expect(rows.map((r) => within(r).getByRole("rowheader").textContent)).toEqual(["1Delgado / OkaforMaya & Sam", "Ito / BauerKen & Lena", "Raman / WhitfieldPriya & Cole"]);
    expect(rows.map((r) => r.getAttribute("data-team-id"))).toEqual(["a", "c", "b"]);
    expect(screen.getByText("Court 3 · 2 of 3 played")).toBeInTheDocument();

    const aVsB = screen.getByRole("link", { name: "Delgado / Okafor versus Raman / Whitfield: Final, sets 21–18" });
    expect(aVsB).toHaveAttribute("href", "/m/m1");
    expect(aVsB.textContent).toBe("21–18");
    // The same meeting from the other side.
    expect(screen.getByRole("link", { name: "Raman / Whitfield versus Delgado / Okafor: Final, sets 18–21" }).textContent).toBe("18–21");
    expect(screen.getByRole("link", { name: "Ito / Bauer versus Raman / Whitfield: Decided by forfeit" }).textContent).toBe("W (ff)");
    expect(screen.getByRole("link", { name: /Delgado \/ Okafor versus Ito \/ Bauer: In progress, 21–19, 7–9/ }).textContent).toBe("7–9");

    // Records come from the standings rows.
    const records = rows.map((r) => within(r).getAllByRole("cell").at(-1)?.textContent);
    expect(records).toEqual(["1–0", "1–0", "0–2"]);
  });

  it("marks the diagonal, shows scheduled times, and works without links or standings", () => {
    const scheduled = [match("m9", "a", "b", { href: null })];
    render(<PoolTable label="Pool B" courtLabel="Court 1" teams={teams.slice(0, 2)} matches={scheduled} timeZone={TZ} />);
    expect(screen.getAllByLabelText("Same team")).toHaveLength(2);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.getAllByText("8:30 AM")).toHaveLength(2);
    expect(screen.getByText("Court 1 · 0 of 1 played")).toBeInTheDocument();
  });
});
