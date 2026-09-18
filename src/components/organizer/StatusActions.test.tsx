// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { settlementCopy, StatusActions } from "@/components/organizer/StatusActions";
import { ToastProvider } from "@/components/ui/Toast";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

afterEach(cleanup);

const base = { tournamentId: "t1", patchable: [] as const, matchCount: 51 };

describe("StatusActions: settlement copy follows the real state", () => {
  it("a rule-7.3.4 freeze (awaiting settlement, nothing closed) says play is paused and points at the Lucra page and the close flow", () => {
    render(
      <ToastProvider>
        <StatusActions {...base} status="awaiting_settlement" closed={false} lucraAlert={{ code: "matchup_ambiguous", message: "Lucra returned 2 matchups for externalId sideout-x.", blocking: true }} />
      </ToastProvider>,
    );
    const copy = screen.getByTestId("settlement-copy");
    expect(copy).toHaveTextContent("Play is paused");
    expect(copy).toHaveTextContent("Lucra returned 2 matchups");
    expect(copy).toHaveTextContent("forfeit the remaining matches");
    expect(screen.getByRole("link", { name: "Open the Lucra page" })).toHaveAttribute("href", "/admin/lucra");
    expect(screen.getByRole("link", { name: "Open the close flow" })).toHaveAttribute("href", "/organizer/events/t1/close");
    expect(copy).not.toHaveTextContent("phase 4");
  });

  it("a closed event whose settlement Lucra refused names the refusal and the retry", () => {
    render(
      <ToastProvider>
        <StatusActions {...base} status="awaiting_settlement" closed lucraAlert={{ code: "unlinked_players", message: "2 prize-winning players are not linked to a Lucra account.", blocking: true }} />
      </ToastProvider>,
    );
    const copy = screen.getByTestId("settlement-copy");
    expect(copy).toHaveTextContent("Closed. Lucra settlement was refused: 2 prize-winning players are not linked");
    expect(copy).toHaveTextContent("settle again");
    expect(screen.getByRole("link", { name: "Open the Lucra page" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See the frozen close preview" })).toHaveAttribute("href", "/organizer/events/t1/close");
  });

  it("a closed event with no alert says settlement has not completed; a settled one says so, with any partial notice", () => {
    expect(settlementCopy("awaiting_settlement", true, null)).toEqual({ text: "Closed. Lucra settlement has not completed; settle again if it was interrupted.", needsLucraPage: true });
    expect(settlementCopy("settled", true, null)).toEqual({ text: "Settled through Lucra.", needsLucraPage: false });
    expect(settlementCopy("settled", true, { code: "settlement_partial", message: "Lucra could not assign 1 reward.", blocking: false })).toEqual({ text: "Settled through Lucra. Lucra could not assign 1 reward.", needsLucraPage: true });
    expect(settlementCopy("live", false, null)).toBeNull();
    render(
      <ToastProvider>
        <StatusActions {...base} status="settled" closed lucraAlert={null} />
      </ToastProvider>,
    );
    expect(screen.getByTestId("settlement-copy")).toHaveTextContent("Settled through Lucra.");
    expect(screen.queryByRole("link", { name: "Open the Lucra page" })).not.toBeInTheDocument();
  });
});
