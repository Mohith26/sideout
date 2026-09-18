"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Re-render the server components on a cadence while a page is showing live
 * figures, so standings and scores track the rows without the client holding
 * a second copy of the data. Pauses while the tab is hidden and refreshes once
 * on return. Fresh numbers are content, not motion, so reduced-motion
 * preferences do not stop it.
 */
export function LiveRefresh({ intervalMs }: { intervalMs: number }) {
  const router = useRouter();
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(() => router.refresh(), intervalMs);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        router.refresh();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [router, intervalMs]);
  return null;
}
