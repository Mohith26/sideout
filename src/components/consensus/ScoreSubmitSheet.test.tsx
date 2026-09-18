// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ScoreSubmitSheet, type SubmitResponse } from "@/components/consensus/ScoreSubmitSheet";
import type { SubmittedSet } from "@/domain/consensus";
import type { ApiEnvelope } from "@/lib/api";
import { useOutboxStoreForTests } from "@/lib/offline/client";
import { MemoryOutbox } from "@/lib/offline/outbox";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

beforeAll(() => {
  // jsdom does not implement <dialog>'s modal API.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});

afterEach(cleanup);

const us = { id: "team-us", name: "Marchetti / Hayashi" };
const them = { id: "team-them", name: "Ahmadi / El-Amin" };

const A_SETS = [
  { setNumber: 1, teamAPoints: 21, teamBPoints: 19 },
  { setNumber: 2, teamAPoints: 23, teamBPoints: 25 },
  { setNumber: 3, teamAPoints: 9, teamBPoints: 15 },
];

function respond(outcome: SubmitResponse["outcome"], extra: Partial<SubmitResponse> = {}): ApiEnvelope<SubmitResponse> {
  return {
    ok: true,
    data: {
      outcome,
      replaced: false,
      perspective: "b",
      consensus: { state: outcome, disputedReason: null, live: [], differences: [] },
      match: { match: { winnerTeamId: null, teamAId: them.id, teamBId: us.id } },
      ...extra,
    },
  };
}

/** Type a set into the visible row `index` (0-based), our points first. */
function enterSet(index: number, ours: number, theirs: number) {
  const sheet = screen.getByTestId("score-sheet");
  const inputs = within(sheet).getAllByRole("textbox");
  const our = inputs[index * 2];
  const their = inputs[index * 2 + 1];
  if (!our || !their) throw new Error(`no inputs for row ${index}`);
  fireEvent.focus(our);
  fireEvent.change(our, { target: { value: String(ours) } });
  fireEvent.blur(our);
  fireEvent.focus(their);
  fireEvent.change(their, { target: { value: String(theirs) } });
  fireEvent.blur(their);
}

function openSheet(submit: (matchId: string, sets: SubmittedSet[]) => Promise<ApiEnvelope<SubmitResponse>>, props: Partial<React.ComponentProps<typeof ScoreSubmitSheet>> = {}) {
  render(<ScoreSubmitSheet matchId="m1" bestOf="3" us={us} them={them} perspective="b" existing={null} opponentSubmitted={false} submit={submit} {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /Submit score|Confirm the result|Change your scoreline/ }));
  return screen.getByTestId("score-sheet");
}

describe("ScoreSubmitSheet", () => {
  it("opens as a bottom sheet with one row per set, live legality, and submit disabled until the scoreline is legal", () => {
    const submit = vi.fn();
    const sheet = openSheet(submit);
    expect(sheet.className).toContain("sheet-enter");
    expect(screen.getByRole("dialog")).toHaveAttribute("open");
    expect(within(sheet).getAllByRole("listitem")).toHaveLength(2);
    const submitButton = within(sheet).getByRole("button", { name: "Submit scoreline" });
    expect(submitButton).toBeDisabled();
    expect(screen.getByTestId("match-verdict")).toHaveTextContent("Best of 3");

    enterSet(0, 21, 20);
    expect(within(sheet).getByText("Set 1: Sets are won by 2; 21–20 is not a finished set.")).toBeInTheDocument();
    expect(submitButton).toBeDisabled();
    enterSet(0, 19, 21);
    enterSet(1, 25, 23);
    // Split sets: a third row appears and the match is still undecided.
    expect(within(sheet).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByTestId("match-verdict")).toHaveTextContent("Nobody has won 2 set(s) yet");
    expect(submitButton).toBeDisabled();
    enterSet(2, 15, 9);
    expect(screen.getByTestId("match-verdict")).toHaveTextContent("Legal result: Your team win 2–1 in sets.");
    expect(submitButton).toBeEnabled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("first submitter: posts own points first and sees 'Waiting on {opponent}' with why both must agree", async () => {
    const submit = vi.fn(async () => respond("awaiting_second"));
    const sheet = openSheet(submit);
    enterSet(0, 19, 21);
    enterSet(1, 25, 23);
    enterSet(2, 15, 9);
    await act(async () => {
      fireEvent.click(within(sheet).getByRole("button", { name: "Submit scoreline" }));
    });
    expect(submit).toHaveBeenCalledWith("m1", [
      { setNumber: 1, usPoints: 19, themPoints: 21 },
      { setNumber: 2, usPoints: 25, themPoints: 23 },
      { setNumber: 3, usPoints: 15, themPoints: 9 },
    ]);
    expect(within(sheet).getByRole("heading", { name: "Waiting on Ahmadi / El-Amin" })).toBeInTheDocument();
    expect(within(sheet).getByText(/both teams have to agree before a result counts/)).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("second and agreeing: one surf check, then Final", async () => {
    const submit = vi.fn(async () => respond("agreed", { match: { match: { winnerTeamId: us.id, teamAId: them.id, teamBId: us.id } } }));
    const sheet = openSheet(submit, { opponentSubmitted: true });
    enterSet(0, 19, 21);
    enterSet(1, 25, 23);
    enterSet(2, 15, 9);
    await act(async () => {
      fireEvent.click(within(sheet).getByRole("button", { name: "Submit scoreline" }));
    });
    expect(within(sheet).getByRole("heading", { name: "Final" })).toBeInTheDocument();
    const check = screen.getByTestId("confirm-check");
    expect(check.className).toContain("confirm-enter");
    expect(check.className).toContain("bg-surf");
    expect(within(sheet).getByText(/Both teams agree\. The match is final — your team wins\./)).toBeInTheDocument();
  });

  it("second and differing: both scorelines side by side, the differing set marked, and no blame", async () => {
    const theirs = [A_SETS[0]!, A_SETS[1]!, { setNumber: 3, teamAPoints: 11, teamBPoints: 15 }];
    const submit = vi.fn(async () =>
      respond("disputed", {
        consensus: {
          state: "disputed",
          disputedReason: "Set 3 differs: 11–15 vs 9–15",
          live: [
            { teamId: them.id, teamName: them.name, sets: theirs, submittedBy: { displayName: "Zara" } },
            { teamId: us.id, teamName: us.name, sets: A_SETS, submittedBy: { displayName: "Sofia" } },
          ],
          differences: [{ setNumber: 3 }],
        },
      }),
    );
    const sheet = openSheet(submit, { opponentSubmitted: true });
    enterSet(0, 19, 21);
    enterSet(1, 25, 23);
    enterSet(2, 15, 9);
    await act(async () => {
      fireEvent.click(within(sheet).getByRole("button", { name: "Submit scoreline" }));
    });
    expect(within(sheet).getByRole("heading", { name: "Scorelines differ" })).toBeInTheDocument();
    const rows = within(sheet).getAllByRole("row").filter((r) => r.hasAttribute("data-differs"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Set 3");
    expect(within(rows[0]!).getByText("Differs")).toBeInTheDocument();
    expect(within(sheet).getByText(/The organizer will settle it with both teams; nothing is final until then\./)).toBeInTheDocument();
    const copy = sheet.textContent ?? "";
    for (const word of ["wrong", "lied", "cheat", "fault", "blame", "incorrect"]) expect(copy.toLowerCase()).not.toContain(word);
  });

  it("shows a server refusal inline and keeps the entries", async () => {
    const submit = vi.fn(async (): Promise<ApiEnvelope<SubmitResponse>> => ({ ok: false, error: { code: "bad_request", message: "Set 3: Past 15 a set ends the moment one side leads by 2; 21–15 cannot happen.", detail: { code: "illegal_scoreline", setNumber: 3 } } }));
    const sheet = openSheet(submit);
    enterSet(0, 19, 21);
    enterSet(1, 25, 23);
    enterSet(2, 15, 9);
    await act(async () => {
      fireEvent.click(within(sheet).getByRole("button", { name: "Submit scoreline" }));
    });
    expect(within(sheet).getByRole("alert")).toHaveTextContent("Set 3: Past 15");
    expect(within(sheet).getByRole("button", { name: "Submit scoreline" })).toBeEnabled();
    expect(within(sheet).getAllByRole("textbox")[0]).toHaveValue("19");
  });

  it("prefills an existing submission for a change and labels the trigger accordingly", () => {
    render(
      <ScoreSubmitSheet
        matchId="m1"
        bestOf="3"
        us={us}
        them={them}
        perspective="b"
        existing={[
          { setNumber: 1, usPoints: 19, themPoints: 21 },
          { setNumber: 2, usPoints: 25, themPoints: 23 },
          { setNumber: 3, usPoints: 15, themPoints: 9 },
        ]}
        opponentSubmitted={false}
        submit={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Change your scoreline" }));
    const sheet = screen.getByTestId("score-sheet");
    expect(within(sheet).getAllByRole("textbox").map((i) => (i as HTMLInputElement).value)).toEqual(["19", "21", "25", "23", "15", "9"]);
    expect(within(sheet).getByRole("button", { name: "Replace scoreline" })).toBeEnabled();
  });

  it("closes by playing the exit (translateY down and a fade) and only then leaves the DOM; without animations it closes at once", async () => {
    const sheet = openSheet(vi.fn());
    // jsdom has no Web Animations: Cancel closes immediately.
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("score-sheet")).not.toBeInTheDocument();

    // With a running animation, the sheet swaps to the exit keyframes and waits for it to finish.
    let finish: (() => void) | null = null;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit score" }));
    const again = screen.getByTestId("score-sheet");
    Object.defineProperty(again, "getAnimations", { configurable: true, value: () => [{ finished }] });
    fireEvent.click(within(again).getByRole("button", { name: "Cancel" }));
    expect(again.className).toContain("sheet-exit");
    expect(again.className).not.toContain("sheet-enter");
    expect(again).toHaveAttribute("data-closing", "true");
    expect(screen.getByTestId("score-sheet")).toBeInTheDocument();
    await act(async () => {
      finish!();
      await finished;
    });
    expect(screen.queryByTestId("score-sheet")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { hidden: true })).not.toHaveAttribute("open");
  });

  it("with no connection, saves the scoreline in the outbox exactly as it would have been sent and says so plainly", async () => {
    const store = new MemoryOutbox();
    useOutboxStoreForTests(store);
    try {
      const submit = vi.fn(async () => ({ ok: false as const, error: { code: "unavailable" as const, message: "Could not reach Sideout." }, status: 0 }));
      const sheet = openSheet(submit);
      enterSet(0, 21, 12);
      enterSet(1, 21, 15);
      await act(async () => {
        fireEvent.click(within(sheet).getByRole("button", { name: "Submit scoreline" }));
      });
      expect(within(sheet).getByRole("heading", { name: "Saved on this phone" })).toBeInTheDocument();
      expect(within(sheet).getByTestId("queued-notice")).toHaveTextContent("No connection right now. Your scoreline is saved on this phone and will be sent, with the same checks, as soon as you are back online.");
      expect(within(sheet).getByTestId("queued-notice")).toHaveTextContent(`Nothing is final until ${them.name} submits the same result.`);
      const queued = await store.list();
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        matchId: "m1",
        path: "/api/matches/m1/scores",
        status: "queued",
        body: {
          sets: [
            { setNumber: 1, usPoints: 21, themPoints: 12 },
            { setNumber: 2, usPoints: 21, themPoints: 15 },
          ],
        },
      });
      // A server error is queued too; a definitive refusal is not.
      expect(within(sheet).getByRole("button", { name: "Done" })).toBeInTheDocument();
    } finally {
      useOutboxStoreForTests(null);
    }
  });

  it("a definitive refusal is shown inline, never queued", async () => {
    const store = new MemoryOutbox();
    useOutboxStoreForTests(store);
    try {
      const submit = vi.fn(async () => ({ ok: false as const, error: { code: "conflict" as const, message: "That team already submitted.", detail: { code: "already_submitted_by_team" } }, status: 409 }));
      const sheet = openSheet(submit);
      enterSet(0, 21, 12);
      enterSet(1, 21, 15);
      await act(async () => {
        fireEvent.click(within(sheet).getByRole("button", { name: "Submit scoreline" }));
      });
      expect(within(sheet).getByRole("alert")).toHaveTextContent("That team already submitted.");
      expect(await store.list()).toEqual([]);
    } finally {
      useOutboxStoreForTests(null);
    }
  });
});
