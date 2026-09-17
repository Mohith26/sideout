import "server-only";
import { notFound } from "next/navigation";
import { DatabaseNotReadyError } from "@/db/connection";
import { getTournamentSummaryBySlug, type TournamentSummary } from "@/db/queries/tournaments";

/** Resolve the tournament for a tab page; the layout already rendered the not-ready state. */
export function requireTournament(slug: string): TournamentSummary {
  try {
    const summary = getTournamentSummaryBySlug(slug);
    if (!summary) notFound();
    return summary;
  } catch (err) {
    if (err instanceof DatabaseNotReadyError) notFound();
    throw err;
  }
}
