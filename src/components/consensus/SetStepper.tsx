"use client";

import { useId, useState } from "react";
import { Icons } from "@/components/ui/icons";
import { cx } from "@/lib/cx";

/**
 * One team's points in one set, sized for sandy wet hands (spec §11.3,
 * §12.6): the minus and plus buttons are 56×56, larger than the 44px floor
 * everything else uses, and the number itself is a numeric field so a phone
 * shows its keypad and "21" is two taps, not twenty-one. The stepper takes a
 * whole line, the team's name at the start and the controls at the end: two
 * of these do not fit side by side at 390px, and the end of the line is
 * where a thumb reaches.
 */
export const STEPPER_MIN = 0;
export const STEPPER_MAX = 99;

export interface SetStepperProps {
  /** Whose points: "Your team", "Sandbar Sharks". */
  label: string;
  setNumber: number;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  /** Visual emphasis for the side that won the set as entered. */
  leading?: boolean;
  className?: string;
}

function clamp(n: number): number {
  return Math.min(STEPPER_MAX, Math.max(STEPPER_MIN, Math.trunc(n)));
}

export function SetStepper({ label, setNumber, value, onChange, disabled = false, leading = false, className }: SetStepperProps) {
  const id = useId();
  // The field shows the typed text while it has focus so a user can clear it and retype.
  const [draft, setDraft] = useState<string | null>(null);
  const name = `${label}, set ${setNumber}`;
  const step = (delta: number) => {
    setDraft(null);
    onChange(clamp(value + delta));
  };
  return (
    <div role="group" aria-labelledby={`${id}-label`} className={cx("flex items-center justify-between gap-3", className)}>
      <span id={`${id}-label`} className="min-w-0 flex-1 truncate type-label text-text-secondary">
        {label}
        <span className="sr-only">, set {setNumber}</span>
      </span>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          aria-label={`Decrease ${name}`}
          onClick={() => step(-1)}
          disabled={disabled || value <= STEPPER_MIN}
          className="surface-raised flex size-14 shrink-0 items-center justify-center rounded-sm text-text-primary transition-[background-color,border-color] duration-(--d-micro) ease-(--ease-out-expo) select-none hover:border-border-strong active:bg-bg-overlay disabled:pointer-events-none disabled:opacity-40"
        >
          <Icons.minus size={22} />
        </button>
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          aria-label={`${name} points`}
          value={draft ?? String(value)}
          disabled={disabled}
          onFocus={(e) => {
            setDraft(String(value));
            e.currentTarget.select();
          }}
          onChange={(e) => {
            const digits = e.currentTarget.value.replace(/[^0-9]/g, "").slice(0, 2);
            setDraft(digits);
            if (digits !== "") onChange(clamp(Number(digits)));
          }}
          onBlur={() => {
            if (draft === "") onChange(STEPPER_MIN);
            setDraft(null);
          }}
          className={cx(
            "h-14 w-16 rounded-sm border bg-bg-inset text-center type-display-l text-text-primary tabular outline-none focus-visible:border-volt disabled:opacity-40",
            leading ? "border-surf/50" : "border-border-subtle",
          )}
        />
        <button
          type="button"
          aria-label={`Increase ${name}`}
          onClick={() => step(1)}
          disabled={disabled || value >= STEPPER_MAX}
          className="surface-raised flex size-14 shrink-0 items-center justify-center rounded-sm text-text-primary transition-[background-color,border-color] duration-(--d-micro) ease-(--ease-out-expo) select-none hover:border-border-strong active:bg-bg-overlay disabled:pointer-events-none disabled:opacity-40"
        >
          <Icons.plus size={22} />
        </button>
      </div>
    </div>
  );
}
