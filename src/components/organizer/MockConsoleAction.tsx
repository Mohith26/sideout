"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Icons } from "@/components/ui/icons";
import { Notice } from "@/components/ui/Notice";
import { api } from "@/lib/api-client";

/**
 * Mock mode only: the organizer's stand-in for Lucra's console. In sandbox
 * or production a Lucra representative creates the tournament with this
 * event's externalId (open question 6); here the in-process mock is Lucra,
 * so the organizer creates it, and the registered roster enters the way the
 * SDK would. Rendered only when the read-back found no matchup.
 */
export function MockConsoleAction({ tournamentId, externalId }: { tournamentId: string; externalId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "info" | "attention"; text: string } | null>(null);

  async function create() {
    setBusy(true);
    setNote(null);
    const res = await api<{ matchupId: string; created: boolean; participants: number; unlinked: Array<{ displayName: string }> }>("/api/rest/_mock/tournaments", { body: { tournamentId, enterRoster: true } });
    setBusy(false);
    if (!res.ok) {
      setNote({ tone: "attention", text: res.error.message });
      return;
    }
    const { created, participants, unlinked } = res.data;
    setNote({
      tone: unlinked.length ? "attention" : "info",
      text: `${created ? "Created in the mock" : "Already in the mock"}; ${participants} participant${participants === 1 ? "" : "s"} entered.${unlinked.length ? ` Not entered (never signed in to Lucra): ${unlinked.map((u) => u.displayName).join(", ")}.` : ""} Verify targeting to cache the matchup.`,
    });
    router.refresh();
  }

  return (
    <Notice tone="info" title="Lucra mock: no tournament for this event yet">
      <p>
        Lucra (the in-process mock here) has no tournament with externalId <span className="font-mono text-[13px]">{externalId}</span>. In sandbox or production a Lucra representative creates it in their console; in mock mode you can, and the
        registered roster enters as if each player had signed in and joined.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={() => void create()} disabled={busy} aria-busy={busy} iconStart={<Icons.plus size={16} />} data-testid="mock-create-tournament">
          Create in the Lucra mock and enter the roster
        </Button>
        {note ? (
          <span role="status" className={note.tone === "attention" ? "text-fault" : "text-text-secondary"}>
            {note.text}
          </span>
        ) : null}
      </div>
    </Notice>
  );
}
