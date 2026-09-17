// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ImpactMeter } from "@/components/tournament/ImpactMeter";

describe("ImpactMeter", () => {
  it("derives the percentage and remaining amount from cents and exposes a progressbar", () => {
    render(<ImpactMeter raisedCents={443500} goalCents={750000} currency="USD" donorCount={60} />);
    const bar = screen.getByRole("progressbar", { name: "Fundraising progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "443500");
    expect(bar).toHaveAttribute("aria-valuemax", "750000");
    expect(screen.getByText("$4,435")).toBeInTheDocument();
    expect(screen.getByText("59%")).toBeInTheDocument();
    expect(screen.getByText("$3,065 to go")).toBeInTheDocument();
    expect(screen.getByText("60")).toBeInTheDocument();
  });

  it("reads above 100% when the goal is met but caps the bar", () => {
    const { container } = render(<ImpactMeter raisedCents={523500} goalCents={500000} currency="USD" />);
    expect(screen.getByText("105%")).toBeInTheDocument();
    expect(screen.getByText("Goal met")).toBeInTheDocument();
    expect(screen.getByText("+$235 over")).toBeInTheDocument();
    const fill = container.querySelector('[role="progressbar"] > div');
    expect(fill).toHaveStyle({ width: "100%" });
  });
});
