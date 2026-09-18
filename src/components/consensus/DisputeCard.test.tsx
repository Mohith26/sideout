// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DisputeCard, type ResolveResponse } from "@/components/consensus/DisputeCard";
import type { DisputeView } from "@/db/queries/consensus";
import type { ApiEnvelope } from "@/lib/api";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(cleanup);

const aSets = [
  { setNumber: 1, teamAPoints: 21, teamBPoints: 18 },
  { setNumber: 2, teamAPoints: 19, teamBPoints: 21 },
  { setNumber: 3, teamAPoints: 15, teamBPoints: 13 },
];
const bSets = [aSets[0]!, aSets[1]!, { setNumber: 3, teamAPoints: 15, teamBPoints: 11 }];

const dispute: DisputeView = {
  match: {
    id: "m1",
    tournamentId: "t1",
    poolId: null,
    round: 2,
    bracketPosition: 11,
    courtLabel: "Court 3",
    teamAId: "ta",
    teamBId: "tb",
    bestOf: "3",
    status: "disputed",
    winnerTeamId: null,
    nextMatchId: null,
    nextMatchSlot: null,
    scheduledAt: 0,
    startedAt: 0,
    finalizedAt: null,
  },
  tournament: { id: "t1", slug: "sandbar", name: "Sandbar Classic" },
  poolLabel: null,
  roundLabel: "Quarterfinals",
  teamA: { id: "ta", name: "de Vries / Castellanos" },
  teamB: { id: "tb", name: "Petrov / Cohen" },
  consensus: {
    matchId: "m1",
    state: "disputed",
    disputedReason: "Set 3 differs: 15–13 vs 15–11",
    resolvedBy: null,
    updatedAt: 0,
    agreedSets: null,
    live: [
      { id: "s1", teamId: "ta", teamName: "de Vries / Castellanos", submittedBy: { userId: "u1", displayName: "Bram de Vries", role: "player" }, sets: aSets, hash: "h1", createdAt: 0, supersededById: null },
      { id: "s2", teamId: "tb", teamName: "Petrov / Cohen", submittedBy: { userId: "u2", displayName: "Silas Petrov", role: "player" }, sets: bSets, hash: "h2", createdAt: 0, supersededById: null },
    ],
    history: [],
    differences: [{ setNumber: 3, a: aSets[2]!, b: bSets[2]! }],
  },
};

describe("DisputeCard", () => {
  it("shows both scorelines with the differing set marked, prefills from either side, and attributes the resolution", async () => {
    const resolve = vi.fn(
      async (): Promise<ApiEnvelope<ResolveResponse>> => ({
        ok: true,
        data: { consensus: { state: "agreed", agreedSets: aSets, resolvedBy: { userId: "org", displayName: "Nadia Okafor" } }, match: { match: { status: "final", winnerTeamId: "ta" } } },
      }),
    );
    render(<DisputeCard dispute={dispute} timeZone="UTC" resolve={resolve} />);
    const card = screen.getByTestId("dispute-card");
    expect(within(card).getByText("Set 3 differs: 15–13 vs 15–11")).toBeInTheDocument();
    expect(within(card).getAllByRole("row").filter((r) => r.hasAttribute("data-differs"))).toHaveLength(1);
    const resolveButton = within(card).getByRole("button", { name: "Resolve as organizer" });
    expect(resolveButton).toBeDisabled();

    fireEvent.click(within(card).getByRole("button", { name: "Start from de Vries / Castellanos" }));
    expect(within(card).getAllByRole("textbox").map((i) => (i as HTMLInputElement).value)).toEqual(["21", "18", "19", "21", "15", "13"]);
    expect(resolveButton).toBeEnabled();

    await act(async () => {
      fireEvent.click(resolveButton);
    });
    expect(resolve).toHaveBeenCalledWith("m1", aSets);
    expect(within(card).getByText(/Settled by/)).toHaveTextContent("Nadia Okafor");
    expect(within(card).getByText("Final")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Resolve as organizer" })).not.toBeInTheDocument();
  });

  it("surfaces a refusal without losing the form", async () => {
    const resolve = vi.fn(async (): Promise<ApiEnvelope<ResolveResponse>> => ({ ok: false, error: { code: "conflict", message: "Only a disputed match can be resolved; this one is agreed.", detail: { code: "invalid_transition" } } }));
    render(<DisputeCard dispute={dispute} timeZone="UTC" resolve={resolve} />);
    const card = screen.getByTestId("dispute-card");
    fireEvent.click(within(card).getByRole("button", { name: "Start from Petrov / Cohen" }));
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "Resolve as organizer" }));
    });
    expect(within(card).getByRole("alert")).toHaveTextContent("Only a disputed match can be resolved");
    expect(within(card).getByRole("button", { name: "Resolve as organizer" })).toBeEnabled();
  });
});
