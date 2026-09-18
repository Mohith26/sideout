// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { easeOutExpo, ScoreDisplay } from "@/components/motion/ScoreDisplay";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, "matchMedia", { configurable: true, value: undefined });
});

/** Drive requestAnimationFrame by hand so the roll can be stepped through. */
function frameClock() {
  let now = 0;
  const queue: FrameRequestCallback[] = [];
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    queue.push(cb);
    return queue.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  return {
    advance(ms: number) {
      now += ms;
      const pending = queue.splice(0);
      act(() => {
        for (const cb of pending) cb(now);
      });
    },
  };
}

describe("ScoreDisplay", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: undefined });
  });

  it("renders the value as is on first paint, tabular", () => {
    render(<ScoreDisplay value={17} />);
    const el = screen.getByText("17");
    expect(el.className).toContain("score-roll");
    expect(el.dataset.value).toBe("17");
    expect(el.dataset.rolling).toBeUndefined();
  });

  it("rolls from the previous value to the new one over --d-base and settles exactly on it", () => {
    const clock = frameClock();
    const { rerender } = render(<ScoreDisplay value={10} />);
    rerender(<ScoreDisplay value={20} />);
    // Still showing the old value until the first frame.
    expect(screen.getByText("10").dataset.rolling).toBe("true");
    clock.advance(110);
    const mid = Number(screen.getByText(/^\d+$/).textContent);
    expect(mid).toBeGreaterThan(10);
    expect(mid).toBeLessThanOrEqual(20);
    expect(mid).toBe(Math.round(10 + 10 * easeOutExpo(0.5)));
    clock.advance(200);
    const el = screen.getByText("20");
    expect(el.dataset.rolling).toBeUndefined();
    expect(el.className).toContain("score-settle");
  });

  it("under reduced motion the number changes at once and only the opacity settle remains", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }),
    });
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const { rerender } = render(<ScoreDisplay value={3} />);
    rerender(<ScoreDisplay value={9} />);
    expect(screen.getByText("9").className).toContain("score-settle");
    expect(raf).not.toHaveBeenCalled();
  });
});
