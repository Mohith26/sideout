import { cx } from "@/lib/cx";

/**
 * The live pulse (spec §12.4, transition 6): a --surf dot that breathes on a
 * 2s cycle, on live indicators only. Decorative beside its label, so hidden
 * from assistive tech; under reduced motion it holds still (motion.css).
 */
export function LiveDot({ className }: { className?: string }) {
  return <span aria-hidden="true" data-live-dot="" className={cx("live-dot inline-block size-2 shrink-0 rounded-full bg-surf", className)} />;
}
