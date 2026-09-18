import type { MatchSlot, MatchStatus } from "@/db/schema";
import type { DrawPlan } from "@/domain/draw";
import { bracketRoundLabel } from "@/lib/rounds";

/**
 * The bracket's view model and layout, pure so the public tab, the organizer
 * preview and the tests share one geometry. Nodes come either from match rows
 * (`nodesFromMatches`) or from a `DrawPlan` before it is committed
 * (`nodesFromPlan`); the SVG in `Bracket.tsx` only draws what `layoutBracket`
 * returns.
 *
 * Geometry: rounds are columns, round 1 stacks its matches top to bottom, and
 * every later match sits at the midpoint of the two matches that feed it (found
 * through `nextId`, the same link `matches.next_match_id` carries). Connectors
 * are one `<path>` per feeder so phase 5 can animate the winner's path with
 * `stroke-dashoffset`.
 */

export interface BracketTeamRef {
  id: string;
  name: string;
  seed: number | null;
  /** Player display names, captain first. */
  members: string[];
}

export interface BracketNode {
  id: string;
  round: number;
  /** Order within the round; `matches.bracket_position` for rows. */
  position: number;
  teamA: BracketTeamRef | null;
  teamB: BracketTeamRef | null;
  status: MatchStatus;
  winnerId: string | null;
  nextId: string | null;
  nextSlot: MatchSlot | null;
  courtLabel: string | null;
  scheduledAt: number | null;
  /** Agreed or provisional set scores, in order. Empty for a bye or a dispute. */
  sets: Array<{ a: number; b: number }>;
  /** Where the node opens; null in a preview, where the match does not exist yet. */
  href: string | null;
}

export const NODE_WIDTH = 244;
export const NODE_HEIGHT = 68;
export const COLUMN_GAP = 56;
export const ROW_GAP = 20;
export const HEADER_HEIGHT = 36;
export const PADDING = 16;

export interface PlacedNode {
  node: BracketNode;
  x: number;
  y: number;
}

export interface BracketColumn {
  round: number;
  label: string;
  x: number;
  nodes: PlacedNode[];
}

export interface Connector {
  /** `${fromId}->${toId}` */
  id: string;
  fromId: string;
  toId: string;
  slot: MatchSlot;
  d: string;
  /** The feeder has a winner, so the path has been "walked". */
  advanced: boolean;
}

export interface BracketLayout {
  width: number;
  height: number;
  rounds: number;
  columns: BracketColumn[];
  connectors: Connector[];
  /** Node id → placed node, for focus and pan targets. */
  byId: Map<string, PlacedNode>;
}

function centerY(p: PlacedNode): number {
  return p.y + NODE_HEIGHT / 2;
}

export function layoutBracket(nodes: readonly BracketNode[]): BracketLayout {
  const rounds = nodes.length ? Math.max(...nodes.map((n) => n.round)) : 0;
  const byRound = new Map<number, BracketNode[]>();
  for (const n of nodes) {
    const list = byRound.get(n.round) ?? [];
    list.push(n);
    byRound.set(n.round, list);
  }
  for (const list of byRound.values()) list.sort((a, b) => a.position - b.position);

  const byId = new Map<string, PlacedNode>();
  const columns: BracketColumn[] = [];
  const feedersOf = new Map<string, PlacedNode[]>();

  for (let r = 1; r <= rounds; r += 1) {
    const list = byRound.get(r) ?? [];
    const x = PADDING + (r - 1) * (NODE_WIDTH + COLUMN_GAP);
    const placed: PlacedNode[] = [];
    // Fallback spacing for a round whose feeders are unknown (a skeleton with no links).
    const stride = (NODE_HEIGHT + ROW_GAP) * 2 ** (r - 1);
    const offset = ((NODE_HEIGHT + ROW_GAP) * (2 ** (r - 1) - 1)) / 2;
    list.forEach((node, i) => {
      const feeders = feedersOf.get(node.id) ?? [];
      const y =
        feeders.length > 0
          ? feeders.reduce((s, f) => s + centerY(f), 0) / feeders.length - NODE_HEIGHT / 2
          : HEADER_HEIGHT + PADDING + offset + i * stride;
      const p: PlacedNode = { node, x, y };
      placed.push(p);
      byId.set(node.id, p);
      if (node.nextId) {
        const f = feedersOf.get(node.nextId) ?? [];
        f.push(p);
        feedersOf.set(node.nextId, f);
      }
    });
    columns.push({ round: r, label: bracketRoundLabel(r, rounds), x, nodes: placed });
  }

  const connectors: Connector[] = [];
  for (const column of columns) {
    for (const p of column.nodes) {
      const { node } = p;
      if (!node.nextId || !node.nextSlot) continue;
      const target = byId.get(node.nextId);
      if (!target) continue;
      const x1 = p.x + NODE_WIDTH;
      const y1 = centerY(p);
      const x2 = target.x;
      const y2 = target.y + (node.nextSlot === "a" ? NODE_HEIGHT * 0.28 : NODE_HEIGHT * 0.72);
      const mid = x1 + COLUMN_GAP / 2;
      connectors.push({
        id: `${node.id}->${node.nextId}`,
        fromId: node.id,
        toId: node.nextId,
        slot: node.nextSlot,
        d: `M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`,
        advanced: node.winnerId !== null,
      });
    }
  }

  const bottom = Math.max(HEADER_HEIGHT + PADDING, ...[...byId.values()].map((p) => p.y + NODE_HEIGHT));
  return {
    width: rounds === 0 ? 0 : PADDING * 2 + rounds * NODE_WIDTH + (rounds - 1) * COLUMN_GAP,
    height: rounds === 0 ? 0 : bottom + PADDING,
    rounds,
    columns,
    connectors,
    byId,
  };
}

// ---------------------------------------------------------------------------
// Current match and keyboard navigation
// ---------------------------------------------------------------------------

const CURRENT_PRIORITY: Partial<Record<MatchStatus, number>> = { in_progress: 0, awaiting_scores: 1, disputed: 2, scheduled: 3 };

/**
 * The match to pin: what is on the sand, else what is waiting for a result,
 * else what is disputed, else the next scheduled match with both teams known
 * (earliest first), else the last resolved match (the final, once played).
 */
export function pickCurrentMatch(nodes: readonly BracketNode[]): BracketNode | null {
  const candidates = nodes
    .filter((n) => CURRENT_PRIORITY[n.status] !== undefined && (n.status !== "scheduled" || (n.teamA && n.teamB)))
    .sort((x, y) => (CURRENT_PRIORITY[x.status] ?? 9) - (CURRENT_PRIORITY[y.status] ?? 9) || (x.scheduledAt ?? 0) - (y.scheduledAt ?? 0) || x.position - y.position);
  if (candidates[0]) return candidates[0];
  const resolved = nodes.filter((n) => n.status === "final" || n.status === "forfeited").sort((x, y) => y.round - x.round || y.position - x.position);
  return resolved[0] ?? null;
}

export type Direction = "up" | "down" | "left" | "right" | "home" | "end";

/** The node focus moves to from `id` in `direction`, or null at an edge. */
export function neighborOf(layout: BracketLayout, id: string, direction: Direction): string | null {
  const from = layout.byId.get(id);
  if (!from) return null;
  const column = layout.columns.find((c) => c.round === from.node.round);
  if (!column) return null;
  const index = column.nodes.indexOf(from);
  switch (direction) {
    case "up":
      return column.nodes[index - 1]?.node.id ?? null;
    case "down":
      return column.nodes[index + 1]?.node.id ?? null;
    case "home":
      return column.nodes[0]?.node.id ?? null;
    case "end":
      return column.nodes[column.nodes.length - 1]?.node.id ?? null;
    case "right": {
      if (from.node.nextId && layout.byId.has(from.node.nextId)) return from.node.nextId;
      return nearestInRound(layout, from.node.round + 1, centerY(from));
    }
    case "left": {
      const feeders = layout.columns.find((c) => c.round === from.node.round - 1)?.nodes.filter((p) => p.node.nextId === from.node.id) ?? [];
      const nearest = feeders.sort((a, b) => Math.abs(centerY(a) - centerY(from)) - Math.abs(centerY(b) - centerY(from)))[0];
      if (nearest) return nearest.node.id;
      return nearestInRound(layout, from.node.round - 1, centerY(from));
    }
  }
}

function nearestInRound(layout: BracketLayout, round: number, y: number): string | null {
  const column = layout.columns.find((c) => c.round === round);
  if (!column || column.nodes.length === 0) return null;
  let best: PlacedNode | null = null;
  for (const p of column.nodes) {
    if (!best || Math.abs(centerY(p) - y) < Math.abs(centerY(best) - y)) best = p;
  }
  return best?.node.id ?? null;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** The shape of a match row plus its teams, as `MatchView` carries it; structural so no server module is imported here. */
export interface MatchLike {
  match: {
    id: string;
    round: number;
    bracketPosition: number | null;
    poolId: string | null;
    status: MatchStatus;
    winnerTeamId: string | null;
    nextMatchId: string | null;
    nextMatchSlot: MatchSlot | null;
    courtLabel: string | null;
    scheduledAt: number | null;
  };
  teamA: TeamLike | null;
  teamB: TeamLike | null;
  sets: ReadonlyArray<{ teamAPoints: number; teamBPoints: number }>;
}

export interface TeamLike {
  id: string;
  name: string;
  seed: number | null;
  members: ReadonlyArray<{ displayName: string }>;
}

export function teamRef(team: TeamLike | null): BracketTeamRef | null {
  if (!team) return null;
  return { id: team.id, name: team.name, seed: team.seed, members: team.members.map((m) => m.displayName) };
}

/** Bracket nodes from match rows; pool matches are ignored. A disputed match shows no numbers, because none are agreed. */
export function nodesFromMatches(matches: readonly MatchLike[]): BracketNode[] {
  return matches
    .filter((m) => m.match.poolId === null)
    .map((m) => ({
      id: m.match.id,
      round: m.match.round,
      position: m.match.bracketPosition ?? 0,
      teamA: teamRef(m.teamA),
      teamB: teamRef(m.teamB),
      status: m.match.status,
      winnerId: m.match.winnerTeamId,
      nextId: m.match.nextMatchId,
      nextSlot: m.match.nextMatchSlot,
      courtLabel: m.match.courtLabel,
      scheduledAt: m.match.scheduledAt,
      sets: m.match.status === "disputed" ? [] : m.sets.map((s) => ({ a: s.teamAPoints, b: s.teamBPoints })),
      href: `/m/${m.match.id}`,
    }));
}

/** Bracket nodes from an uncommitted draw plan (the organizer preview). Nothing links anywhere yet. */
export function nodesFromPlan(plan: Pick<DrawPlan, "matches">, teams: Record<string, { name: string; seed: number | null }>): BracketNode[] {
  const ref = (id: string | null): BracketTeamRef | null => {
    if (!id) return null;
    const t = teams[id];
    return { id, name: t?.name ?? "Team", seed: t?.seed ?? null, members: [] };
  };
  return plan.matches
    .filter((m) => m.poolKey === null)
    .map((m) => ({
      id: m.key,
      round: m.round,
      position: m.bracketPosition ?? 0,
      teamA: ref(m.teamAId),
      teamB: ref(m.teamBId),
      status: m.status,
      winnerId: m.winnerTeamId,
      nextId: m.nextMatchKey,
      nextSlot: m.nextMatchSlot,
      courtLabel: m.courtLabel,
      scheduledAt: m.scheduledAt,
      sets: [],
      href: null,
    }));
}

/** Cut a label to what fits `widthPx` at roughly `charPx` per glyph, with an ellipsis. */
export function fitText(text: string, widthPx: number, charPx = 6.6): string {
  const max = Math.max(3, Math.floor(widthPx / charPx));
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
