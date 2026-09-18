// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloseFlow, type CloseResponse } from "@/components/consensus/CloseFlow";
import type { ApiEnvelope } from "@/lib/api";
import type { ClosePreview } from "@/server/close";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(cleanup);

const tournament = { id: "t1", name: "Sandbar Classic", slug: "sandbar", status: "live", venueTimezone: "UTC" };
const hash = "a".repeat(64);
const clean: ClosePreview = {
  tournamentId: "t1",
  tournamentStatus: "live",
  standings: [
    { placement: 1, teamId: "ta", teamName: "Duarte / Reyes", basis: "bracket", detail: "Won the final", wins: 6, losses: 0 },
    { placement: 2, teamId: "tb", teamName: "de Vries / Castellanos", basis: "bracket", detail: "Lost the final", wins: 6, losses: 1 },
  ],
  rewards: [{ id: "r1", placement: 1, teamId: "ta", teamName: "Duarte / Reyes", kind: "lucra_reward", amountCents: 100000, currency: "USD", description: "Champions", }],
  blockers: [],
  standingsProvisional: false,
  previewHash: hash,
  matchesFinal: 51,
  matchesTotal: 51,
};

describe("CloseFlow", () => {
  it("lists what is blocking instead of a preview", () => {
    const blocked: ClosePreview = {
      ...clean,
      blockers: [{ matchId: "m11", roundLabel: "Quarterfinals", courtLabel: "Court 3", teamA: { id: "ta", name: "A" }, teamB: { id: "tb", name: "B" }, status: "disputed", consensusState: "disputed", reason: "The two scorelines differ. Resolve the dispute with an authoritative scoreline, or forfeit one side." }],
      standingsProvisional: true,
      matchesFinal: 50,
    };
    render(<CloseFlow tournament={tournament} preview={blocked} stored={null} closedByName={null} />);
    expect(screen.getByText("1 match is blocking the close")).toBeInTheDocument();
    expect(screen.getByTestId("blocking-list")).toHaveTextContent("Quarterfinals · Court 3");
    expect(screen.getByTestId("blocking-list")).toHaveTextContent("Resolve the dispute");
    expect(screen.queryByTestId("preview-hash")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Continue to confirm/ })).not.toBeInTheDocument();
  });

  it("is an explicit two-step confirm that posts the preview hash and then shows the frozen result", async () => {
    const close = vi.fn(
      async (): Promise<ApiEnvelope<CloseResponse>> => ({
        ok: true,
        data: {
          detail: { tournament: { status: "awaiting_settlement" } },
          frozen: { tournamentId: "t1", standings: clean.standings, rewards: clean.rewards, previewHash: hash, closedAt: 1_700_000_000_000, closedByUserId: "org" },
          settlement: { state: "settled", matchupId: "matchup-1", unassignedUserIds: [], writes: 0 },
        },
      }),
    );
    render(<CloseFlow tournament={tournament} preview={clean} stored={null} closedByName="Nadia Okafor" close={close} />);
    expect(screen.getByTestId("preview-hash")).toHaveTextContent(hash);
    expect(screen.getAllByText("Duarte / Reyes")).toHaveLength(2); // a standing and a reward
    expect(screen.getByText("$1,000")).toBeInTheDocument();
    expect(close).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Continue to confirm/ }));
    expect(screen.getByTestId("close-confirm")).toHaveTextContent("Step 2 of 2");
    expect(close).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close tournament" }));
    });
    expect(close).toHaveBeenCalledWith("t1", hash);
    expect(screen.getByTestId("close-result")).toHaveTextContent("closed and settled through Lucra");
    expect(screen.getByTestId("close-result")).toHaveTextContent("Lucra settled the tournament (matchup matchup-1)");
    expect(screen.getByText(/Closed .* by Nadia Okafor/)).toBeInTheDocument();
  });

  it("refuses to proceed on a stale preview or new blockers, without closing", async () => {
    const close = vi.fn(async (): Promise<ApiEnvelope<CloseResponse>> => ({ ok: false, error: { code: "conflict", message: "The standings or rewards changed since the preview was taken. Review the new preview before closing.", detail: { code: "preview_stale", previewHash: "b".repeat(64) } } }));
    render(<CloseFlow tournament={tournament} preview={clean} stored={null} closedByName={null} close={close} />);
    fireEvent.click(screen.getByRole("button", { name: /Continue to confirm/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close tournament" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("changed since the preview was taken");
    expect(screen.getByRole("button", { name: "Reload the preview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close tournament" })).toBeDisabled();
    expect(screen.queryByTestId("close-result")).not.toBeInTheDocument();
  });

  it("shows the frozen preview once the tournament is closed", () => {
    render(
      <CloseFlow
        tournament={{ ...tournament, status: "awaiting_settlement" }}
        preview={{ ...clean, tournamentStatus: "awaiting_settlement" }}
        stored={{ tournamentId: "t1", standings: clean.standings, rewards: clean.rewards, previewHash: hash, closedAt: 1_700_000_000_000, closedByUserId: "org" }}
        closedByName="Nadia Okafor"
      />,
    );
    expect(screen.getByTestId("close-result")).toBeInTheDocument();
    expect(screen.getByTestId("preview-hash")).toHaveTextContent(hash);
    expect(screen.queryByRole("button", { name: "Close tournament" })).not.toBeInTheDocument();
  });
});
