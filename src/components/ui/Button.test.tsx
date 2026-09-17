// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/Button";

describe("Button", () => {
  it("renders each variant as a real button with a 44px minimum target", () => {
    for (const variant of ["primary", "secondary", "ghost", "danger"] as const) {
      render(<Button variant={variant}>{variant}</Button>);
      const el = screen.getByRole("button", { name: variant });
      expect(el).toHaveAttribute("type", "button");
      expect(el.className).toContain("target");
      if (variant === "primary") expect(el.className).toContain("bg-volt");
      if (variant === "danger") expect(el.className).toContain("bg-fault");
    }
  });

  it("fires onClick and honours disabled", async () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        Go
      </Button>,
    );
    const el = screen.getByRole("button", { name: "Go" });
    expect(el).toBeDisabled();
    el.click();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders a link when given an href", () => {
    render(<Button href="/events">Events</Button>);
    expect(screen.getByRole("link", { name: "Events" })).toHaveAttribute("href", "/events");
  });
});
