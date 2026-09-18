import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "@/lib/cx";

/**
 * The one button. `primary` is coral (`--volt`) and there is exactly one per
 * screen; if two buttons are both primary, one of them is wrong (spec §12.1).
 * Every variant sits on a 2px flat underline, the cartoon depth, and presses
 * down onto it.
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "md" | "lg";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-volt text-on-volt border border-volt shadow-[0_2px_0_0_var(--volt-dim)] hover:bg-volt-dim hover:border-volt-dim active:translate-y-px active:shadow-none",
  secondary: "surface-raised text-text-primary hover:border-border-strong active:translate-y-px active:shadow-none",
  ghost: "bg-transparent border border-transparent text-text-secondary hover:text-text-primary hover:bg-bg-raised",
  danger: "bg-fault text-on-volt border border-fault shadow-[0_2px_0_0_var(--border-strong)] hover:opacity-90 active:translate-y-px active:shadow-none",
};

const SIZE: Record<ButtonSize, string> = {
  md: "h-11 px-4 text-body",
  lg: "h-12 px-5 text-subheading",
};

/** A wrapping button grows in height instead of widening the page (a label that carries a team name). */
const SIZE_WRAP: Record<ButtonSize, string> = {
  md: "min-h-11 px-4 py-2 text-body",
  lg: "min-h-12 px-5 py-2.5 text-subheading",
};

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-sm font-semibold select-none " +
  "transition-[background-color,border-color,color,opacity] duration-(--d-micro) ease-(--ease-out-expo) " +
  "disabled:opacity-50 disabled:pointer-events-none target";

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconStart?: ReactNode;
  iconEnd?: ReactNode;
  className?: string;
  /** Let a long label wrap onto more lines rather than overflow; the button grows in height. */
  wrap?: boolean;
  children: ReactNode;
}

export type ButtonProps = CommonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> & { href?: undefined };

export type LinkButtonProps = CommonProps & { href: string; prefetch?: boolean; "aria-label"?: string };

export function Button(props: ButtonProps | LinkButtonProps) {
  const { variant = "secondary", size = "md", iconStart, iconEnd, className, wrap = false, children } = props;
  const classes = cx(BASE, wrap ? "text-center whitespace-normal" : "whitespace-nowrap", VARIANT[variant], wrap ? SIZE_WRAP[size] : SIZE[size], className);
  const content = (
    <>
      {iconStart}
      <span>{children}</span>
      {iconEnd}
    </>
  );
  if (props.href !== undefined) {
    const { href, prefetch, "aria-label": ariaLabel } = props;
    return (
      <Link href={href} {...(prefetch === undefined ? {} : { prefetch })} {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })} className={classes}>
        {content}
      </Link>
    );
  }
  const { variant: _v, size: _s, iconStart: _is, iconEnd: _ie, className: _c, wrap: _w, children: _ch, href: _h, ...rest } = props;
  return (
    <button type="button" className={classes} {...rest}>
      {content}
    </button>
  );
}
