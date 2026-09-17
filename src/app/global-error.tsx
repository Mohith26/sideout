"use client";

import { useEffect } from "react";
import { log } from "@/lib/log";

/** Last-resort boundary when the root layout itself fails; must render its own <html>. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    log.error("global error", { digest: error.digest ?? null }, error);
  }, [error]);
  return (
    <html lang="en">
      <body style={{ background: "#08090B", color: "#F4F5F7", fontFamily: "system-ui, sans-serif", padding: 24 }}>
        <h1 style={{ fontSize: 24, margin: 0 }}>Sideout could not start</h1>
        <p style={{ color: "#9BA3AF", maxWidth: 560 }}>The application shell failed to render. Reload to try again.</p>
        <button
          type="button"
          onClick={reset}
          style={{ background: "#D7FF3E", color: "#08090B", border: 0, borderRadius: 6, padding: "12px 16px", fontWeight: 600, minHeight: 44 }}
        >
          Reload
        </button>
      </body>
    </html>
  );
}
