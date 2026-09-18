import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

/** The label-style section heading every screen uses, with an optional trailing figure or action. */
export function SectionHeading({ id, children, aside, className }: { id?: string; children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <div className={cx("mb-3 flex items-baseline justify-between gap-3", className)}>
      <h2 id={id} className="type-label text-text-tertiary">
        {children}
      </h2>
      {aside ? <div className="type-label text-text-tertiary">{aside}</div> : null}
    </div>
  );
}
