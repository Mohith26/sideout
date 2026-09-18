"use client";

import { useLucra } from "@/components/lucra/LucraGate";
import { Button } from "@/components/ui/Button";
import { Icons } from "@/components/ui/icons";

/**
 * "Rewards" on the profile (spec §7.5, §11.5): opens Lucra's rewards sheet.
 * `lucra-web-sdk` 1.12.0 has no dedicated rewards route; a tournament's
 * earned rewards live on its detail screen and the rest on the profile, so
 * the sheet opens on the most recently rewarded event's matchup when there
 * is one (see `docs/open-questions.md`).
 */
export function RewardsAction({ matchupId }: { matchupId: string | null }) {
  const lucra = useLucra();
  if (lucra.status.kind === "unconfigured") return null;
  return (
    <Button variant="secondary" disabled={lucra.busy || lucra.status.kind !== "ready"} onClick={() => void lucra.launch("rewards", matchupId ? { matchupId } : {})} iconStart={<Icons.gift size={16} />}>
      Rewards in Lucra
    </Button>
  );
}
