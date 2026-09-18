import "server-only";
import { notFound } from "next/navigation";
import { DatabaseNotReadyError } from "@/db/connection";
import { findUserTeamInTournament } from "@/db/queries/teams";
import { getTournamentSummaryBySlug, isPublished, type TournamentSummary } from "@/db/queries/tournaments";
import type { Team, User } from "@/db/schema";
import { viewer } from "@/server/auth/viewer";

/**
 * A draft is unpublished: it does not exist for the public, exactly as the API
 * answers, but an organizer may open it to preview what the page will show.
 */
export function visibleTo(summary: TournamentSummary | null, user: User | null): TournamentSummary | null {
  if (!summary) return null;
  if (!isPublished(summary.tournament.status) && user?.role !== "organizer") return null;
  return summary;
}

/** The tournament a `/t/[slug]` render may show to the current viewer, or null. */
export async function findVisibleTournament(slug: string): Promise<TournamentSummary | null> {
  const summary = getTournamentSummaryBySlug(slug);
  if (!summary) return null;
  return visibleTo(summary, isPublished(summary.tournament.status) ? null : await viewer());
}

/** Resolve the tournament for a tab page; the layout already rendered the not-ready state. */
export async function requireTournament(slug: string): Promise<TournamentSummary> {
  let summary: TournamentSummary | null;
  try {
    summary = await findVisibleTournament(slug);
  } catch (err) {
    if (err instanceof DatabaseNotReadyError) notFound();
    throw err;
  }
  if (!summary) notFound();
  return summary;
}

/** The signed-in viewer's live team in this event; null when anonymous or not entered. */
export async function viewerTeam(tournamentId: string): Promise<Team | null> {
  const user = await viewer();
  if (!user) return null;
  return findUserTeamInTournament(user.id, tournamentId);
}

/** Its id alone, for highlighting the viewer's own row. */
export async function viewerTeamId(tournamentId: string): Promise<string | null> {
  return (await viewerTeam(tournamentId))?.id ?? null;
}
