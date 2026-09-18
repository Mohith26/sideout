import { describe, expect, it } from "vitest";
import { ACTOR_KINDS, MATCH_STATUSES, TOURNAMENT_STATUSES, type ActorKind, type MatchStatus, type TournamentStatus } from "@/db/schema";
import { allowedTournamentTargets, DRAWABLE_STATUSES, MATCH_TRANSITIONS, TERMINAL_MATCH_STATUSES, TOURNAMENT_TRANSITIONS, transitionMatch, transitionTournament } from "@/domain/transitions";

const actor = (kind: ActorKind) => ({ kind, userId: kind === "system" || kind === "lucra_webhook" ? null : "u1" });

describe("tournament transitions", () => {
  // Rows: from; columns: to. Cell = the actor kinds allowed, "" = illegal.
  const table: Record<TournamentStatus, Partial<Record<TournamentStatus, readonly ActorKind[]>>> = {
    draft: { registration_open: ["organizer"], cancelled: ["organizer"] },
    registration_open: { registration_closed: ["organizer"], cancelled: ["organizer"] },
    registration_closed: { live: ["organizer"], cancelled: ["organizer"] },
    live: { awaiting_settlement: ["organizer", "system"] },
    awaiting_settlement: { settled: ["organizer", "system"] },
    settled: {},
    cancelled: {},
  };

  it("matches the documented matrix for every (from, to, actor) triple", () => {
    for (const from of TOURNAMENT_STATUSES) {
      for (const to of TOURNAMENT_STATUSES) {
        for (const kind of ACTOR_KINDS) {
          const allowed = table[from][to]?.includes(kind) ?? false;
          const verdict = transitionTournament(from, to, actor(kind));
          expect(verdict.ok, `${from} → ${to} as ${kind}`).toBe(allowed);
          if (!verdict.ok) expect(verdict.reason).toMatch(from === to ? /already/ : /cannot go|Only/);
        }
      }
    }
    expect(TOURNAMENT_TRANSITIONS).toHaveLength(8);
  });

  it("cancels only before live, and never reopens a cancelled or settled event", () => {
    for (const from of ["draft", "registration_open", "registration_closed"] as const) expect(transitionTournament(from, "cancelled", actor("organizer")).ok).toBe(true);
    expect(transitionTournament("live", "cancelled", actor("organizer")).ok).toBe(false);
    expect(transitionTournament("cancelled", "draft", actor("organizer")).ok).toBe(false);
    expect(transitionTournament("settled", "live", actor("system")).ok).toBe(false);
  });

  it("keeps settlement edges away from players", () => {
    expect(transitionTournament("live", "awaiting_settlement", actor("player")).ok).toBe(false);
  });

  it("draws only in registration_closed", () => {
    expect([...DRAWABLE_STATUSES]).toEqual(["registration_closed"]);
  });
});

describe("match transitions", () => {
  const table: Record<MatchStatus, Partial<Record<MatchStatus, readonly ActorKind[]>>> = {
    scheduled: { in_progress: ["player", "organizer", "system"], forfeited: ["organizer"], bye: ["system"] },
    in_progress: { awaiting_scores: ["player", "organizer", "system"], forfeited: ["organizer"] },
    awaiting_scores: { disputed: ["system"], final: ["system"], forfeited: ["organizer"] },
    disputed: { final: ["system"], forfeited: ["organizer"] },
    final: {},
    forfeited: {},
    bye: {},
  };

  it("matches the documented matrix for every (from, to, actor) triple", () => {
    for (const from of MATCH_STATUSES) {
      for (const to of MATCH_STATUSES) {
        for (const kind of ACTOR_KINDS) {
          const allowed = table[from][to]?.includes(kind) ?? false;
          expect(transitionMatch(from, to, actor(kind)).ok, `${from} → ${to} as ${kind}`).toBe(allowed);
        }
      }
    }
    expect(MATCH_TRANSITIONS).toHaveLength(10);
  });

  it("lets only the consensus engine (system) set final, never a player or organizer route", () => {
    for (const kind of ACTOR_KINDS) {
      const canFinal = MATCH_STATUSES.some((from) => transitionMatch(from, "final", actor(kind)).ok);
      expect(canFinal, kind).toBe(kind === "system");
    }
  });

  it("treats final, forfeited and bye as terminal", () => {
    for (const from of TERMINAL_MATCH_STATUSES) {
      for (const to of MATCH_STATUSES) {
        for (const kind of ACTOR_KINDS) expect(transitionMatch(from, to, actor(kind)).ok).toBe(false);
      }
    }
  });
});

describe("allowedTournamentTargets", () => {
  it("lists exactly the edges the actor may take, in machine order", () => {
    expect(allowedTournamentTargets("draft", { kind: "organizer" })).toEqual(["registration_open", "cancelled"]);
    expect(allowedTournamentTargets("registration_closed", { kind: "organizer" })).toEqual(["live", "cancelled"]);
    expect(allowedTournamentTargets("live", { kind: "organizer" })).toEqual(["awaiting_settlement"]);
    expect(allowedTournamentTargets("live", { kind: "player" })).toEqual([]);
    expect(allowedTournamentTargets("settled", { kind: "organizer" })).toEqual([]);
    for (const from of TOURNAMENT_STATUSES) {
      for (const to of allowedTournamentTargets(from, { kind: "organizer" })) {
        expect(transitionTournament(from, to, { kind: "organizer", userId: "u" })).toEqual({ ok: true });
      }
    }
  });
});
