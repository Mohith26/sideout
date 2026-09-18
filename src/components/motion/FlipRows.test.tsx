// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlipRows } from "@/components/motion/FlipRows";

afterEach(cleanup);

/** jsdom has no layout: rows report a top of 40px times their index in the table. */
function layoutByIndex() {
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      const parent = this.parentElement;
      const index = parent ? Array.from(parent.children).indexOf(this) : 0;
      const top = index * 40;
      return { top, left: 0, width: 300, height: 40, right: 300, bottom: top + 40, x: 0, y: top, toJSON: () => ({}) };
    },
  });
}

function Table({ order }: { order: string[] }) {
  return (
    <table>
      <tbody>
        {order.map((id, i) => (
          <tr key={id} data-team-id={id} data-rank={i + 1}>
            <td>
              <span data-rank-delta-slot="" />
              {id}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

describe("FlipRows", () => {
  const animate = vi.fn();
  beforeEach(() => {
    layoutByIndex();
    animate.mockReset();
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  });

  it("plays nothing on first render and slides the rows that moved on a re-render", () => {
    const onFlip = vi.fn();
    const { rerender, container } = render(
      <FlipRows onFlip={onFlip}>
        <Table order={["a", "b", "c"]} />
      </FlipRows>,
    );
    expect(onFlip).not.toHaveBeenCalled();
    rerender(
      <FlipRows onFlip={onFlip}>
        <Table order={["b", "a", "c"]} />
      </FlipRows>,
    );
    expect(onFlip).toHaveBeenCalledWith(["b", "a"]);
    expect(animate).toHaveBeenCalledTimes(2);
    // The first keyframe is the inverse of the move: b came from 40px below its new spot.
    expect(animate.mock.calls[0]?.[0]).toEqual([{ transform: "translate(0px, 40px)" }, { transform: "none" }]);
    expect(animate.mock.calls[0]?.[1]).toMatchObject({ duration: 220 });
    const b = container.querySelector<HTMLElement>("[data-team-id='b']");
    expect(b?.classList.contains("rank-flash")).toBe(true);
    expect(b?.querySelector("[data-rank-delta-slot]")?.textContent).toBe("↑1");
  });

  it("under reduced motion the slide becomes an opacity-only cross-fade", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }),
    });
    const { rerender } = render(
      <FlipRows>
        <Table order={["a", "b"]} />
      </FlipRows>,
    );
    rerender(
      <FlipRows>
        <Table order={["b", "a"]} />
      </FlipRows>,
    );
    expect(animate).toHaveBeenCalled();
    for (const call of animate.mock.calls) for (const frame of call[0] as Keyframe[]) expect(Object.keys(frame)).toEqual(["opacity"]);
    Object.defineProperty(window, "matchMedia", { configurable: true, value: undefined });
  });
});
