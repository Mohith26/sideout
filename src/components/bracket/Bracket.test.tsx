// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Bracket } from "@/components/bracket/Bracket";
import type { BracketNode } from "@/components/bracket/model";

beforeAll(() => {
  // jsdom has no layout; the canvas measures itself through ResizeObserver, which the component tolerates missing.
  if (!("ResizeObserver" in globalThis)) {
    class RO {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    Object.defineProperty(globalThis, "ResizeObserver", { value: RO, configurable: true });
  }
});

const team = (n: number) => ({ id: `t${n}`, name: `Team ${n}`, seed: n, members: [`Player ${n}a`, `Player ${n}b`] });

/** Six teams in an eight-slot bracket: seeds 1 and 2 draw byes into the semifinals. */
function sixTeamBracket(): BracketNode[] {
  const base = (position: number, round: number, nextId: string | null, nextSlot: "a" | "b" | null): BracketNode => ({
    id: `m${position}`,
    round,
    position,
    teamA: null,
    teamB: null,
    status: "scheduled",
    winnerId: null,
    nextId,
    nextSlot,
    courtLabel: `Court ${((position - 1) % 2) + 1}`,
    scheduledAt: 1_700_000_000_000 + position * 3_600_000,
    sets: [],
    href: `/m/m${position}`,
  });
  return [
    { ...base(1, 1, "m5", "a"), teamA: team(1), teamB: null, status: "bye", winnerId: "t1" },
    { ...base(2, 1, "m5", "b"), teamA: team(4), teamB: team(5), status: "final", winnerId: "t4", sets: [{ a: 21, b: 17 }, { a: 21, b: 19 }] },
    { ...base(3, 1, "m6", "a"), teamA: team(2), teamB: null, status: "bye", winnerId: "t2" },
    { ...base(4, 1, "m6", "b"), teamA: team(3), teamB: team(6), status: "in_progress", sets: [{ a: 21, b: 18 }, { a: 12, b: 15 }] },
    { ...base(5, 2, "m7", "a"), teamA: team(1), teamB: team(4) },
    { ...base(6, 2, "m7", "b"), teamA: team(2), teamB: null },
    base(7, 3, null, null),
  ];
}

const TZ = "America/Los_Angeles";

afterEach(cleanup);

describe("Bracket", () => {
  it("renders rounds as a list of lists with labels and one link per match", () => {
    render(<Bracket nodes={sixTeamBracket()} timeZone={TZ} label="Sandbar bracket" />);
    const rounds = screen.getByRole("list", { name: "Sandbar bracket rounds" });
    const columns = within(rounds).getAllByRole("listitem").filter((li) => li.getAttribute("aria-label"));
    expect(columns.map((c) => c.getAttribute("aria-label"))).toEqual(["Quarterfinals", "Semifinals", "Final"]);
    expect(screen.getByRole("list", { name: "Quarterfinals matches" })).toBeInTheDocument();
    const links = screen.getAllByRole("link");
    expect(links.filter((l) => l.getAttribute("href")?.startsWith("/m/"))).toHaveLength(7 + 1); // 7 nodes + the pinned "Open" link
    expect(screen.getByRole("link", { name: /Quarterfinals: 4 Team 4 versus 5 Team 5, sets 21–17, 21–19, Court 2, final/ })).toHaveAttribute("href", "/m/m2");
  });

  it("renders byes honestly: one team, the word Bye, and an advanced connector", () => {
    const { container } = render(<Bracket nodes={sixTeamBracket()} timeZone={TZ} />);
    const bye = screen.getByRole("link", { name: /Quarterfinals: 1 Team 1 advances on a bye, Court 1, bye/ });
    expect(bye).toHaveAttribute("data-status", "bye");
    expect(within(bye).getByText("Bye")).toBeInTheDocument();
    expect(within(bye).queryByText("TBD")).not.toBeInTheDocument();
    const paths = container.querySelectorAll('path[data-from="m1"]');
    expect(paths).toHaveLength(1);
    expect(paths[0]).toHaveAttribute("data-to", "m5");
    expect(paths[0]).toHaveAttribute("data-slot", "a");
    expect(paths[0]).toHaveAttribute("data-advanced", "true");
    // A scheduled feeder has not been walked yet.
    expect(container.querySelector('path[data-from="m5"]')).toHaveAttribute("data-advanced", "false");
    // Empty slots read as TBD, never as a bye.
    const final = screen.getByRole("link", { name: /^Final: to be decided versus to be decided/ });
    expect(within(final).getAllByText("TBD")).toHaveLength(2);
  });

  it("pins the live match with its scores in a polite live region and separate connectors per feeder", () => {
    const { container } = render(<Bracket nodes={sixTeamBracket()} timeZone={TZ} />);
    const pinned = container.querySelector('[aria-label="Current match"]');
    expect(pinned).not.toBeNull();
    expect(within(pinned as HTMLElement).getByText("On the sand")).toBeInTheDocument();
    const live = (pinned as HTMLElement).querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain("Team 3");
    expect(live?.textContent).toContain("Team 6");
    expect(within(pinned as HTMLElement).getByRole("link", { name: /Open/ })).toHaveAttribute("href", "/m/m4");
    expect(container.querySelectorAll("path[data-from]")).toHaveLength(6);
  });

  it("moves focus with the arrow keys along a roving tabindex and stays on links Enter can follow", () => {
    const { container } = render(<Bracket nodes={sixTeamBracket()} timeZone={TZ} />);
    const node = (id: string) => container.querySelector(`[data-node-id="${id}"]`) as HTMLElement;
    // The current (live) match is the one tab stop; every other node is reachable by arrows only.
    expect(node("m4").getAttribute("tabindex")).toBe("0");
    expect(node("m1").getAttribute("tabindex")).toBe("-1");
    node("m4").focus();
    expect(document.activeElement).toBe(node("m4"));

    fireEvent.keyDown(node("m4"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(node("m3"));
    expect(node("m3").getAttribute("tabindex")).toBe("0");
    expect(node("m4").getAttribute("tabindex")).toBe("-1");

    fireEvent.keyDown(node("m3"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(node("m6"));
    fireEvent.keyDown(node("m6"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(node("m7"));
    fireEvent.keyDown(node("m7"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(node("m7"));
    fireEvent.keyDown(node("m7"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(node("m5"));
    fireEvent.keyDown(node("m5"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(node("m1"));
    fireEvent.keyDown(node("m1"), { key: "End" });
    expect(document.activeElement).toBe(node("m4"));
    fireEvent.keyDown(node("m4"), { key: "Home" });
    expect(document.activeElement).toBe(node("m1"));
    // Every node is an anchor with an href, so Enter is native navigation.
    expect(node("m1").tagName.toLowerCase()).toBe("a");
    expect(node("m1").getAttribute("href")).toBe("/m/m1");
  });

  it("renders a preview without links as focusable groups and offers the view controls", () => {
    const nodes = sixTeamBracket().map((n) => ({ ...n, href: null }));
    render(<Bracket nodes={nodes} timeZone={TZ} label="Preview" />);
    expect(screen.queryAllByRole("link").filter((l) => l.getAttribute("href")?.startsWith("/m/"))).toHaveLength(0);
    expect(screen.getByRole("group", { name: /Quarterfinals: 1 Team 1 advances on a bye/ })).toHaveAttribute("tabindex", "-1");
    for (const name of ["Zoom in", "Zoom out", "Fit whole bracket", "Go to current match"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Locate" })).toBeInTheDocument();
  });

  it("renders nothing for an empty bracket", () => {
    const { container } = render(<Bracket nodes={[]} timeZone={TZ} />);
    expect(container).toBeEmptyDOMElement();
  });
});
