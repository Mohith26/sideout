// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

beforeAll(() => {
  // jsdom does not implement <dialog>'s modal API.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});

describe("ConfirmDialog", () => {
  it("opens as a modal with an accessible name and wires confirm/cancel", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmDialog open title="Close tournament?" body="Payouts freeze." onConfirm={onConfirm} onCancel={onCancel} confirmLabel="Close it" />);
    const dialog = screen.getByRole("dialog", { name: "Close tournament?" });
    expect(dialog).toHaveAttribute("open");
    expect(screen.getByText("Payouts freeze.")).toBeInTheDocument();
    screen.getByRole("button", { name: "Close it" }).click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    screen.getByRole("button", { name: "Cancel" }).click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("uses the danger variant for destructive confirms and stays closed when not open", () => {
    render(<ConfirmDialog open destructive title="Delete" onConfirm={() => {}} onCancel={() => {}} confirmLabel="Delete" />);
    expect(screen.getByRole("button", { name: "Delete" }).className).toContain("bg-fault");

    const { container } = render(<ConfirmDialog open={false} title="Hidden" onConfirm={() => {}} onCancel={() => {}} />);
    expect(container.querySelector("dialog")).not.toHaveAttribute("open");
  });
});
