import Link from "next/link";
import { cx } from "@/lib/cx";

export function Wordmark({ className }: { className?: string }) {
  return (
    <Link href="/" className={cx("type-heading inline-flex items-center gap-2 text-text-primary", className)} aria-label="Sideout home">
      <span aria-hidden="true" className="inline-block size-2.5 rounded-full bg-volt" />
      Sideout
    </Link>
  );
}
