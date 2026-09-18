"use client";

import { useEffect } from "react";
import { log } from "@/lib/log";

/**
 * Registers `public/sw.js` with the build sha as its cache version, in
 * production builds only: in `next dev` the chunks under /_next/static are
 * not immutable, so a cache-first worker would serve stale code.
 */
export function ServiceWorkerRegistration({ version, enabled = process.env.NODE_ENV === "production" }: { version: string; enabled?: boolean }) {
  useEffect(() => {
    if (!enabled || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(version)}`, { scope: "/" }).catch((err: unknown) => {
      log.warn("service worker registration failed", { message: err instanceof Error ? err.message : String(err) });
    });
  }, [version, enabled]);
  return null;
}

/** Ask the worker to forget the pages it cached for this session (sign-out). */
export function clearCachedPages(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.controller?.postMessage({ type: "clear-pages" });
}
