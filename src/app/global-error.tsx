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
      {/* The token values as literals (`src/styles/tokens.css`): this boundary renders without the stylesheet. */}
      <body style={{ background: "#fbf2df", color: "#172a45", fontFamily: "system-ui, sans-serif", padding: 24 }}>
        <h1 style={{ fontSize: 24, margin: 0 }}>Sideout could not start</h1>
        <p style={{ color: "#3a5170", maxWidth: 560 }}>The application shell failed to render. Reload to try again.</p>
        <button
          type="button"
          onClick={reset}
          style={{ background: "#c33b22", color: "#ffffff", border: 0, borderRadius: 10, padding: "12px 16px", fontWeight: 600, minHeight: 44 }}
        >
          Reload
        </button>
      </body>
    </html>
  );
}
