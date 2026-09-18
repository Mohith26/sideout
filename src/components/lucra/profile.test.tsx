// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LucraGate } from "@/components/lucra/LucraGate";
import { RewardsAction } from "@/components/lucra/RewardsAction";
import { effectiveVerificationState, VerificationRow } from "@/components/lucra/VerificationRow";
import { WalletChip } from "@/components/lucra/WalletChip";
import type { VerificationState } from "@/db/schema";
import { moduleFor, type Script } from "@/test/lucra-sdk";

/**
 * The profile's Lucra rows (spec §11.5) for every verification state, with
 * the wallet chip's signed-in and signed-out faces and the responsible-play
 * links beneath any balance (§4.7). `not_allowed` is terminal: a support
 * link and no action.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const hrefs = { policyHref: "https://example.test/policy", selfLimitHref: "https://example.test/limits", supportHref: "mailto:support@example.test" };
const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { "content-type": "application/json" } });

async function mount(script: Script, ui: React.ReactNode) {
  const { mod, clients } = moduleFor(script);
  render(
    <LucraGate loadSdk={async () => mod} backoffMs={() => 0}>
      {ui}
    </LucraGate>,
  );
  await waitFor(() => expect(document.querySelector("[data-lucra-host]")).not.toBeNull());
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return { clients, client: () => clients[clients.length - 1]! };
}

describe("VerificationRow", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/link")) return ok({ externalId: "ext", lucraUserId: null, verificationState: "unverified", minted: false });
        return ok({ externalId: "ext", lucraUserId: "lucra-user-1", verificationState: "unverified", bound: true, source: "mock", reason: null });
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each([
    ["unverified", "Not verified", "Verify with Lucra"],
    ["demographics_missing", "Lucra needs a few details", "Complete Lucra's form"],
    ["verified", "Verified with Lucra", null],
    ["not_allowed", "Lucra can't offer play to this account", null],
  ] as const)("renders %s as a calm row with at most one action", async (state, title, action) => {
    await mount({ ready: "signed_out" }, <VerificationRow state={state as VerificationState} supportHref={hrefs.supportHref} />);
    const row = screen.getByTestId("verification-row");
    expect(row).toHaveAttribute("data-state", state);
    expect(row).toHaveTextContent(title);
    const buttons = row.querySelectorAll("button");
    if (action) {
      expect(buttons).toHaveLength(1);
      expect(buttons[0]).toHaveTextContent(action);
    } else {
      expect(buttons).toHaveLength(0);
    }
    if (state === "not_allowed") {
      const support = row.querySelector("a");
      expect(support).toHaveAttribute("href", hrefs.supportHref);
      expect(row).toHaveTextContent("nothing to retry");
    } else {
      expect(row.querySelector("a")).toBeNull();
    }
  });

  it("a player with no link yet is shown as not verified with the identity action", async () => {
    await mount({ ready: "signed_out" }, <VerificationRow state={null} supportHref={hrefs.supportHref} />);
    expect(screen.getByTestId("verification-row")).toHaveAttribute("data-state", "none");
    expect(screen.getByRole("button", { name: "Verify with Lucra" })).toBeEnabled();
  });

  it("the SDK's live account status refines the stored state: BLOCKED is not_allowed, VERIFIED is verified", async () => {
    expect(effectiveVerificationState("unverified", { accountStatus: "BLOCKED" })).toBe("not_allowed");
    expect(effectiveVerificationState("unverified", { accountStatus: "AGE_ASSURED_VERIFIED" })).toBe("verified");
    expect(effectiveVerificationState("verified", { accountStatus: "SUSPENDED" })).toBe("not_allowed");
    expect(effectiveVerificationState("demographics_missing", { accountStatus: "UNVERIFIED" })).toBe("demographics_missing");
    expect(effectiveVerificationState(null, null)).toBeNull();
    await mount({ ready: "signed_in", user: { id: "u", accountStatus: "BLOCKED", balance: 0 } }, <VerificationRow state="unverified" supportHref={hrefs.supportHref} />);
    await waitFor(() => expect(screen.getByTestId("verification-row")).toHaveAttribute("data-state", "not_allowed"));
    expect(screen.getByTestId("verification-row").querySelectorAll("button")).toHaveLength(0);
  });

  it("the action launches the identity flow through the gate", async () => {
    const { client } = await mount({ ready: "signed_in", user: { id: "u", accountStatus: "UNVERIFIED" }, completes: { kyc: true } }, <VerificationRow state="unverified" supportHref={hrefs.supportHref} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Verify with Lucra" }));
    });
    await waitFor(() => expect(client().opened).toEqual(["kyc"]));
  });
});

describe("WalletChip", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ externalId: "ext", lucraUserId: "lucra-user-1", verificationState: "verified", bound: true, source: "mock", reason: null })));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("signed out: a sign-in affordance and no balance; signed in: the SDK's balance with the responsible-play links beneath", async () => {
    await mount({ ready: "signed_out" }, <WalletChip {...hrefs} realMoney={false} />);
    const chip = screen.getByTestId("wallet-chip");
    expect(chip).toHaveAttribute("data-state", "signed-out");
    expect(screen.queryByTestId("wallet-balance")).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in with Lucra" })).toBeEnabled();
    expect(screen.queryByTestId("responsible-play")).toBeNull();
    cleanup();

    await mount({ ready: "signed_in", user: { id: "u", balance: 42.5, accountStatus: "VERIFIED" } }, <WalletChip {...hrefs} realMoney={false} />);
    await waitFor(() => expect(screen.getByTestId("wallet-chip")).toHaveAttribute("data-state", "signed-in"));
    expect(screen.getByTestId("wallet-balance")).toHaveTextContent("$42.50");
    const links = screen.getByTestId("responsible-play");
    expect(links.querySelector(`a[href="${hrefs.policyHref}"]`)).not.toBeNull();
    expect(links).toHaveTextContent("Set limits in Lucra");
    // Real money is off: only Lucra's wallet screen is offered, never add funds or withdraw.
    expect(screen.getByRole("button", { name: "Wallet" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Add funds" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
  });

  it("offers add funds and withdraw only behind FEATURE_REAL_MONEY, launching Lucra's own flows", async () => {
    const { client } = await mount({ ready: "signed_in", user: { id: "u", balance: 1, accountStatus: "VERIFIED" }, completes: { deposit: true } }, <WalletChip {...hrefs} realMoney={true} />);
    await waitFor(() => expect(screen.getByTestId("wallet-chip")).toHaveAttribute("data-state", "signed-in"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add funds" }));
    });
    await waitFor(() => expect(client().opened).toEqual(["deposit"]));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    });
    await waitFor(() => expect(client().opened).toEqual(["deposit", "withdraw"]));
  });

  it("a failed initialization shows the surfaced error with a retry, never a balance", async () => {
    await mount({ ready: "init_failed" }, <WalletChip {...hrefs} realMoney={false} />);
    await waitFor(() => expect(screen.getByTestId("wallet-chip")).toHaveAttribute("data-state", "failed"));
    expect(screen.queryByTestId("wallet-balance")).toBeNull();
    expect(screen.getByTestId("lucra-failure-not_initialized")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Try again" }).length).toBeGreaterThan(0);
  });
});

describe("RewardsAction", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ externalId: "ext", lucraUserId: "lucra-user-1", verificationState: "verified", bound: true, source: "mock", reason: null })));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens the rewarded tournament in Lucra when one is known, else Lucra's profile", async () => {
    const { client } = await mount({ ready: "signed_in" }, <RewardsAction matchupId="matchup-9" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Rewards in Lucra" }));
    });
    await waitFor(() => expect(client().opened).toEqual(["tournamentDetails"]));
    cleanup();
    const none = await mount({ ready: "signed_in" }, <RewardsAction matchupId={null} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Rewards in Lucra" }));
    });
    await waitFor(() => expect(none.client().opened).toEqual(["profile"]));
  });
});
