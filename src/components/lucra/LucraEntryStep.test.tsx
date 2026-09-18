// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LucraEntryStep } from "@/components/lucra/LucraEntryStep";
import { LucraGate } from "@/components/lucra/LucraGate";
import type { LucraEntryStatus } from "@/server/lucra";
import { LucraApiError, LucraApiErrorCode, moduleFor, type Script } from "@/test/lucra-sdk";

/**
 * Registration step 2 (spec §11.4): its states before, during and after the
 * SDK's join, with the entry read back from the server (never assumed from
 * the join), and the §7.5 failures it surfaces.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { "content-type": "application/json" } });

function status(overrides: Partial<LucraEntryStatus> = {}): LucraEntryStatus {
  return {
    tournamentId: "t-1",
    teamId: "team-1",
    matchup: { id: "matchup-1", verifiedAt: 1 },
    players: [
      { userId: "me", displayName: "Ana Marchetti", you: true, linked: true, entered: false },
      { userId: "partner", displayName: "Yui Hayashi", you: false, linked: false, entered: false },
    ],
    externalId: "ext-me",
    readBackAt: 1,
    complete: false,
    ...overrides,
  };
}

async function mount(script: Script, initial: LucraEntryStatus, reload = vi.fn(async () => ({ ok: true as const, data: initial }))) {
  const { mod, clients } = moduleFor(script);
  render(
    <LucraGate loadSdk={async () => mod} backoffMs={() => 0}>
      <LucraEntryStep slug="pier-9" tournamentName="Pier 9 Open" initial={initial} supportHref="mailto:support@example.test" reload={reload} />
    </LucraGate>,
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return { clients, client: () => clients[clients.length - 1]!, reload };
}

describe("LucraEntryStep", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ externalId: "ext-me", lucraUserId: "lucra-user-1", verificationState: "verified", bound: true, source: "mock", reason: null })));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the roster's state from the read-back and one volt action, worded for the Lucra session", async () => {
    await mount({ ready: "signed_out" }, status());
    const players = screen.getAllByTestId("entry-player");
    expect(players).toHaveLength(2);
    expect(players[0]).toHaveTextContent("Ana Marchetti");
    expect(players[0]).toHaveTextContent("you");
    expect(players[0]).toHaveTextContent("Signed in, not entered");
    expect(players[1]).toHaveTextContent("Not signed in to Lucra");
    expect(screen.getByTestId("lucra-enter")).toHaveTextContent("Sign in with Lucra and enter");
    expect(screen.getByTestId("lucra-entry-step")).toHaveAttribute("data-complete", "false");
    cleanup();
    await mount({ ready: "signed_in" }, status());
    await waitFor(() => expect(screen.getByTestId("lucra-enter")).toHaveTextContent("Enter the tournament with Lucra"));
    // Exactly one primary action on the card.
    expect(document.querySelectorAll(".bg-volt")).toHaveLength(1);
  });

  it("without a verified matchup there is nothing to press, and the organizer's alert is explained", async () => {
    await mount({ ready: "signed_in" }, status({ matchup: { id: null, reason: "matchup_ambiguous" } }));
    expect(screen.queryByTestId("lucra-enter")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("more than one Lucra tournament");
    cleanup();
    await mount({ ready: "signed_in" }, status({ matchup: { id: null, reason: "matchup_query_failed" } }));
    expect(screen.getByRole("alert")).toHaveTextContent("did not answer");
  });

  it("joins through the SDK, then trusts only the server's read-back: entered when Lucra lists you, waiting on the partner otherwise", async () => {
    const after = status({ players: [{ userId: "me", displayName: "Ana Marchetti", you: true, linked: true, entered: true }, { userId: "partner", displayName: "Yui Hayashi", you: false, linked: true, entered: false }] });
    const reload = vi.fn(async () => ({ ok: true as const, data: after }));
    const { client } = await mount({ ready: "signed_in" }, status(), reload);
    await act(async () => {
      fireEvent.click(screen.getByTestId("lucra-enter"));
    });
    await waitFor(() => expect(screen.getByTestId("lucra-entry-step")).toHaveAttribute("data-phase", "joined"));
    expect(client().joins).toEqual(["matchup-1"]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId("entry-player")[0]).toHaveTextContent("Entered");
    expect(screen.getByRole("status")).toHaveTextContent("Waiting on Yui Hayashi");
    expect(screen.queryByTestId("lucra-enter")).toBeNull();
    expect(screen.getByRole("button", { name: "View the tournament in Lucra" })).toBeEnabled();
  });

  it("both entered: the success state, no action", async () => {
    await mount({ ready: "signed_in" }, status({ complete: true, players: [{ userId: "me", displayName: "Ana", you: true, linked: true, entered: true }, { userId: "p", displayName: "Yui", you: false, linked: true, entered: true }] }));
    expect(screen.getByTestId("lucra-entry-step")).toHaveAttribute("data-complete", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Both players are in");
    expect(screen.queryByTestId("lucra-enter")).toBeNull();
  });

  it("a join Lucra accepted but does not list yet keeps polling the read-back, then says so honestly", async () => {
    const reload = vi.fn(async () => ({ ok: true as const, data: status() }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await mount({ ready: "signed_in" }, status(), reload);
      await act(async () => {
        fireEvent.click(screen.getByTestId("lucra-enter"));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(12_000);
      });
      await waitFor(() => expect(screen.getByTestId("lucra-entry-step")).toHaveAttribute("data-phase", "joined"));
      expect(reload).toHaveBeenCalledTimes(3);
      expect(screen.getByText(/does not show you yet/)).toBeInTheDocument();
      // Lucra says you are not in; the action stays available.
      expect(screen.getByTestId("lucra-enter")).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a NotAllowed account gets the terminal notice with the support path and loses the action", async () => {
    await mount({ ready: "signed_in", user: { id: "u", accountStatus: "BLOCKED" } }, status());
    await act(async () => {
      fireEvent.click(screen.getByTestId("lucra-enter"));
    });
    await waitFor(() => expect(screen.getByTestId("lucra-failure-not_allowed")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /Contact Lucra support/ })).toHaveAttribute("href", "mailto:support@example.test");
    expect(screen.queryByTestId("lucra-enter")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("a location failure shows the location-help state with a retry that runs the join again", async () => {
    const { client } = await mount({ ready: "signed_in", join: [new LucraApiError(LucraApiErrorCode.locationError)] }, status());
    await act(async () => {
      fireEvent.click(screen.getByTestId("lucra-enter"));
    });
    await waitFor(() => expect(screen.getByTestId("lucra-failure-location")).toBeInTheDocument());
    expect(screen.getByText("Lucra couldn't confirm your location")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    await waitFor(() => expect(client().joins).toHaveLength(2));
  });

  it("an abandoned demographic form leaves the failure with its own launch action", async () => {
    const { client } = await mount({ ready: "signed_in", join: [new LucraApiError(LucraApiErrorCode.demographicInformationMissing)], completes: { demographic: false } }, status());
    await act(async () => {
      fireEvent.click(screen.getByTestId("lucra-enter"));
    });
    await waitFor(() => expect(screen.getByTestId("lucra-failure-demographics_missing")).toBeInTheDocument());
    expect(client().opened).toEqual(["demographic"]);
    expect(screen.getByRole("button", { name: "Complete Lucra's form" })).toBeEnabled();
  });
});
