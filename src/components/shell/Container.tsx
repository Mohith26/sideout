import type { ReactNode } from "react";

/** Standard content column: 1280px max, 16px gutters that grow to 32px at desktop (spec §12.3). */
export function Container({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={["mx-auto w-full max-w-content px-gutter", className].filter(Boolean).join(" ")}>{children}</div>;
}
