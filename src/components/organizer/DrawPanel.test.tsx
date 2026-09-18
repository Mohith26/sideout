// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DrawPanel, type DrawPanelProps } from "@/components/organizer/DrawPanel";
import { ToastProvider } from "@/components/ui/Toast";
import type { DrawPreview } from "@/server/draw";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const preview: DrawPreview = {
  stage: "pools",
  rngSeed: 4242,
  plan: { format: "single_elim", order: ["t1", "t2"], pools: [], matches: [], seeds: [], bracket: null },
  teams: { t1: { name: "Alpha", seed: null }, t2: { name: "Bravo", seed: null } },
};

const props: DrawPanelProps = {
  tournamentId: "tour-1",
  format: "single_elim",
  status: "registration_closed",
  timeZone: "America/Los_Angeles",
  startsAt: Date.UTC(2026, 5, 6, 16),
  teams: [
    { id: "t1", name: "Alpha", seed: null },
    { id: "t2", name: "Bravo", seed: null },
  ],
  existing: { matchCount: 0, started: false, bracketSeeded: false, poolsDone: false, unfinishedPoolMatches: 0, config: null },
};

type Sent = { url: string; body: Record<string, unknown> };
const sent: Sent[] = [];

beforeAll(() => {
  // jsdom does not implement <dialog>'s modal API.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});

beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true, data: { preview } }), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPanel() {
  return render(
    <ToastProvider>
      <DrawPanel {...props} />
    </ToastProvider>,
  );
}

describe("DrawPanel", () => {
  it("drops the preview when an input changes, so a commit can only write what was last previewed", async () => {
    renderPanel();
    expect(screen.queryByRole("button", { name: "Commit this draw" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview draw" }));
    await screen.findByRole("button", { name: "Commit this draw" });
    expect(sent[0]?.url).toBe("/api/admin/tournaments/tour-1/draw?preview=1");
    expect(sent[0]?.body.courts).toBe(4);

    fireEvent.change(screen.getByLabelText("Courts"), { target: { value: "6" } });
    expect(screen.queryByRole("button", { name: "Commit this draw" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview draw" }));
    await screen.findByRole("button", { name: "Commit this draw" });
    expect(sent[1]?.body.courts).toBe(6);

    fireEvent.change(screen.getByLabelText("Seed for Alpha"), { target: { value: "1" } });
    expect(screen.queryByRole("button", { name: "Commit this draw" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview draw" }));
    await screen.findByRole("button", { name: "Commit this draw" });
    expect(sent[2]?.body.seeds).toEqual([{ teamId: "t1", seed: 1 }]);

    fireEvent.click(screen.getByRole("button", { name: "Commit this draw" }));
    fireEvent.click(await screen.findByRole("button", { name: "Commit draw" }));
    await waitFor(() => expect(sent).toHaveLength(4));
    expect(sent[3]?.url).toBe("/api/admin/tournaments/tour-1/draw");
    expect(sent[3]?.body).toMatchObject({ courts: 6, seeds: [{ teamId: "t1", seed: 1 }], rngSeed: 4242 });
  });
});
