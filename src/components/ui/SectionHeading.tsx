import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

/** The label-style section heading every screen uses, with an optional trailing figure or action. */
export function SectionHeading({ id, children, aside, level = 2, className }: { id?: string; children: ReactNode; aside?: ReactNode; level?: 2 | 3; className?: string }) {
  const Tag = level === 2 ? "h2" : "h3";
  return (
    <div className={cx("mb-3 flex items-baseline justify-between gap-3", className)}>
      <Tag id={id} className="type-label text-text-tertiary">
        {children}
      </Tag>
      {aside ? <div className="type-label text-text-tertiary">{aside}</div> : null}
    </div>
  );
}
