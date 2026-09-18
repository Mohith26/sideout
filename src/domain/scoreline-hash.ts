import { createHash } from "node:crypto";
import { scorelineSchema, type Scoreline, type Side } from "@/domain/scoreline";

/**
 * The canonical form and hash the consensus state machine compares (spec
 * §10.1). Kept apart from `@/domain/scoreline` because this needs Node's
 * `crypto` and the score sheet judges legality in the browser with the rules
 * alone; nothing under `src/components` may import this module.
 */

// OPEN: (§17.9) Lucra offers no partner-side attestation or dual-confirmation
// contract. The canonical hash and the consensus built on it stand on their own;
// nothing in the Lucra write depends on Lucra acknowledging them.
/**
 * Canonical form: sets ordered by number, always oriented from team A's side,
 * keys in a fixed order, no whitespace. Two honest submissions of the same
 * result — one typed by each team — produce byte-identical output.
 *
 * `perspective` says which team the submitter typed as "us": a team-B submitter
 * enters their own points first, and canonicalization flips them back.
 */
export function canonicalizeScoreline(scoreline: Scoreline, perspective: Side = "a"): string {
  const parsed = scorelineSchema.parse(scoreline);
  const sets = [...parsed.sets]
    .sort((x, y) => x.setNumber - y.setNumber)
    .map((s) => {
      const a = perspective === "a" ? s.teamAPoints : s.teamBPoints;
      const b = perspective === "a" ? s.teamBPoints : s.teamAPoints;
      return `[${s.setNumber},${a},${b}]`;
    });
  return `{"matchId":${JSON.stringify(parsed.matchId)},"sets":[${sets.join(",")}]}`;
}

/** sha256 hex of the canonical scoreline; what `score_submissions.payload_hash` stores. */
export function hashScoreline(scoreline: Scoreline, perspective: Side = "a"): string {
  return createHash("sha256").update(canonicalizeScoreline(scoreline, perspective)).digest("hex");
}
