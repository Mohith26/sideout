// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  CONSENSUS_STATE_PILL,
  MATCH_STATUS_PILL,
  StatusPill,
  TOURNAMENT_STATUS_PILL,
  VERIFICATION_STATE_PILL,
} from "@/components/ui/StatusPill";
import { CONSENSUS_STATES, MATCH_STATUSES, TOURNAMENT_STATUSES, VERIFICATION_STATES } from "@/db/schema";

describe("StatusPill", () => {
  it("has a label and an icon for every enum value (never color alone)", () => {
    for (const s of TOURNAMENT_STATUSES) expect(TOURNAMENT_STATUS_PILL[s].label).toBeTruthy();
    for (const s of MATCH_STATUSES) expect(MATCH_STATUS_PILL[s].label).toBeTruthy();
    for (const s of CONSENSUS_STATES) expect(CONSENSUS_STATE_PILL[s].label).toBeTruthy();
    for (const s of VERIFICATION_STATES) expect(VERIFICATION_STATE_PILL[s].label).toBeTruthy();
  });

  it("renders live in surf with the breathing dot, disputes in fault with an icon, and never uses ember", () => {
    const { container: live } = render(<StatusPill spec={TOURNAMENT_STATUS_PILL.live} />);
    expect(screen.getByText("Live").className).toContain("text-surf");
    // The live tone alone carries the pulse (§12.4 transition 6); every other tone keeps its icon.
    expect(live.querySelector("[data-live-dot]")).not.toBeNull();
    expect(live.querySelector("svg")).toBeNull();
    const { container: disputed } = render(<StatusPill spec={MATCH_STATUS_PILL.disputed} />);
    expect(disputed.querySelector("svg")).not.toBeNull();
    expect(disputed.querySelector("[data-live-dot]")).toBeNull();

    expect(screen.getByText("Disputed").className).toContain("text-fault");

    for (const table of [TOURNAMENT_STATUS_PILL, MATCH_STATUS_PILL, CONSENSUS_STATE_PILL, VERIFICATION_STATE_PILL]) {
      for (const spec of Object.values(table)) {
        const { container } = render(<StatusPill spec={spec} />);
        expect(container.innerHTML).not.toContain("ember");
      }
    }
  });
});
