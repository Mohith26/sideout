// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { SetStepper, STEPPER_MAX } from "@/components/consensus/SetStepper";
import { judgeRows, visibleRows, type EditorSet } from "@/components/consensus/ScorelineEditor";

function Harness({ initial = 0 }: { initial?: number }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <SetStepper label="Your team" setNumber={1} value={value} onChange={setValue} />
      <output data-testid="value">{value}</output>
    </>
  );
}

afterEach(cleanup);

describe("SetStepper", () => {
  it("steps by one with 56px buttons, clamps at the ends, and names every control for a screen reader", () => {
    render(<Harness />);
    const minus = screen.getByRole("button", { name: "Decrease Your team, set 1" });
    const plus = screen.getByRole("button", { name: "Increase Your team, set 1" });
    expect(minus.className).toContain("size-14");
    expect(plus.className).toContain("size-14");
    expect(minus).toBeDisabled();
    fireEvent.click(plus);
    fireEvent.click(plus);
    expect(screen.getByTestId("value")).toHaveTextContent("2");
    fireEvent.click(minus);
    expect(screen.getByTestId("value")).toHaveTextContent("1");
    expect(screen.getByRole("group", { name: "Your team, set 1" })).toBeInTheDocument();
  });

  it("accepts typed digits on a numeric field, ignores anything else, and treats an emptied field as zero", () => {
    render(<Harness initial={5} />);
    const input = screen.getByRole("textbox", { name: "Your team, set 1 points" });
    expect(input).toHaveAttribute("inputmode", "numeric");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "21" } });
    expect(screen.getByTestId("value")).toHaveTextContent("21");
    fireEvent.change(input, { target: { value: "2a1x" } });
    expect(screen.getByTestId("value")).toHaveTextContent("21");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(screen.getByTestId("value")).toHaveTextContent("0");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "999" } });
    expect(Number(screen.getByTestId("value").textContent)).toBeLessThanOrEqual(STEPPER_MAX);
  });
});

describe("ScorelineEditor rows", () => {
  it("shows two rows for best-of-3 and a third only once the first two are legal and split", () => {
    const none: EditorSet[] = [];
    expect(visibleRows(none, "1").map((r) => r.setNumber)).toEqual([1]);
    expect(visibleRows(none, "3").map((r) => r.setNumber)).toEqual([1, 2]);
    const sweep: EditorSet[] = [
      { setNumber: 1, left: 21, right: 18 },
      { setNumber: 2, left: 21, right: 12 },
    ];
    expect(visibleRows(sweep, "3").map((r) => r.setNumber)).toEqual([1, 2]);
    expect(judgeRows(visibleRows(sweep, "3"), "3")).toMatchObject({ legal: true, winner: "a" });
    const split: EditorSet[] = [
      { setNumber: 1, left: 21, right: 18 },
      { setNumber: 2, left: 19, right: 21 },
    ];
    expect(visibleRows(split, "3").map((r) => r.setNumber)).toEqual([1, 2, 3]);
    expect(judgeRows(visibleRows(split, "3"), "3")).toMatchObject({ legal: false });
    const decided = [...split, { setNumber: 3, left: 15, right: 13 }];
    expect(judgeRows(visibleRows(decided, "3"), "3")).toMatchObject({ legal: true, winner: "a" });
    // A stale third set is dropped once the first two no longer split.
    const backToSweep = [{ setNumber: 1, left: 21, right: 18 }, { setNumber: 2, left: 21, right: 19 }, decided[2]!];
    expect(visibleRows(backToSweep, "3").map((r) => r.setNumber)).toEqual([1, 2]);
  });
});
