import Link from "next/link";
import { Volleyball } from "@/components/art";
import { cx } from "@/lib/cx";

/** The wordmark: the volleyball beside the name, on the display face. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <Link href="/" className={cx("type-heading inline-flex items-center gap-2 text-text-primary", className)} aria-label="Sideout home">
      <Volleyball size={28} />
      Sideout
    </Link>
  );
}
