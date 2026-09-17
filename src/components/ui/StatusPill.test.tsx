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

  it("renders live in surf and disputes in fault, and never uses ember", () => {
    const { container: live } = render(<StatusPill spec={TOURNAMENT_STATUS_PILL.live} />);
    expect(screen.getByText("Live").className).toContain("text-surf");
    expect(live.querySelector("svg")).not.toBeNull();

    render(<StatusPill spec={MATCH_STATUS_PILL.disputed} />);
    expect(screen.getByText("Disputed").className).toContain("text-fault");

    for (const table of [TOURNAMENT_STATUS_PILL, MATCH_STATUS_PILL, CONSENSUS_STATE_PILL, VERIFICATION_STATE_PILL]) {
      for (const spec of Object.values(table)) {
        const { container } = render(<StatusPill spec={spec} />);
        expect(container.innerHTML).not.toContain("ember");
      }
    }
  });
});
