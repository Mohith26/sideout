import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Shared setup for the phase-5 flows: seeded identities, a fresh event built
 * through the organizer and player APIs (so no flow touches the seeded
 * events another spec is reading), and the Lucra mock's stand-in console.
 */
export const ORGANIZER_PHONE = "+15550109000";
export const LIVE_SLUG = "sandbar-classic-2026";

/** Seeded player phones (`src/seed/build.ts`): +1555{100+i}{last four of 1000+7i}. */
export function playerPhone(i: number): string {
  return `+1555${String(100 + i).padStart(3, "0")}${String(1000 + i * 7).slice(-4)}`;
}

export type Envelope<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; detail?: unknown } };

export async function devLogin(request: APIRequestContext, who: { phone: string } | { userId: string }): Promise<{ id: string; displayName: string }> {
  const res = await request.post("/api/dev/login", { data: who });
  expect(res.ok(), `dev login ${JSON.stringify(who)} → ${res.status()}`).toBe(true);
  return ((await res.json()) as { data: { user: { id: string; displayName: string } } }).data.user;
}

export async function getJson<T>(request: APIRequestContext, path: string): Promise<T> {
  const res = await request.get(path);
  expect(res.ok(), `${path} → ${res.status()} ${await res.text()}`).toBe(true);
  const body = (await res.json()) as Envelope<T>;
  if (!body.ok) throw new Error(`${path}: ${body.error.message}`);
  return body.data;
}

export async function postJson<T>(request: APIRequestContext, path: string, data: unknown, expected: number | number[] = 200): Promise<T> {
  const res = await request.post(path, { data });
  expect([expected].flat(), `${path} → ${res.status()} ${await res.text()}`).toContain(res.status());
  const body = (await res.json()) as Envelope<T>;
  if (!body.ok) throw new Error(`${path}: ${body.error.message}`);
  return body.data;
}

export interface MatchRef {
  match: { id: string; status: string; round: number; poolId: string | null; bracketPosition: number | null; teamAId: string | null; teamBId: string | null; bestOf: "1" | "3" };
  teamA: { id: string; name: string; members: Array<{ userId: string; displayName: string }> } | null;
  teamB: { id: string; name: string; members: Array<{ userId: string; displayName: string }> } | null;
}

export interface TournamentDetail {
  tournament: { id: string; slug: string; name: string; status: string; beneficiaryId: string };
  teams: Array<{ id: string; name: string; status: string }>;
  pools: Array<{ id: string; label: string; matches: MatchRef[] }>;
  bracket: { rounds: number; matches: MatchRef[] };
}

export async function detail(request: APIRequestContext, slug: string): Promise<TournamentDetail> {
  return getJson<TournamentDetail>(request, `/api/tournaments/${slug}`);
}

export interface OwnEventOptions {
  format: "pool_to_bracket" | "single_elim";
  /** Pairs registered through the API before registration closes. */
  teams: number;
  /** Seeded player index the first pair starts at; each pair takes two. */
  firstPlayer: number;
  entryDonationCents?: number;
  /** Leave registration open (the browser registers a team) instead of closing it. */
  leaveOpen?: boolean;
  namePrefix?: string;
}

/**
 * A fresh event: draft → registration open → `teams` pairs registered →
 * (unless `leaveOpen`) registration closed. The organizer and the players
 * sign in through the dev login on this request context, which ends signed
 * out.
 */
export async function ownEvent(request: APIRequestContext, opts: OwnEventOptions): Promise<{ id: string; slug: string; name: string; teamIds: string[] }> {
  const project = test.info().project.name;
  const slug = `flow-${project}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const name = `${opts.namePrefix ?? "Flow"} ${project} ${Date.now() % 10000}`;
  await devLogin(request, { phone: ORGANIZER_PHONE });
  const seeded = await detail(request, LIVE_SLUG);
  const day = Date.now() + 45 * 24 * 3_600_000;
  const created = await postJson<{ tournament: { id: string } }>(
    request,
    "/api/admin/tournaments",
    {
      slug,
      name,
      beneficiaryId: seeded.tournament.beneficiaryId,
      venueName: "Flow Courts",
      venueCity: "Santa Cruz",
      venueState: "CA",
      venueTimezone: "America/Los_Angeles",
      startsAt: day,
      endsAt: day + 8 * 3_600_000,
      format: opts.format,
      division: "open",
      maxTeams: 4,
      entryDonationCents: opts.entryDonationCents ?? 0,
      fundraisingGoalCents: 100000,
    },
    201,
  );
  const id = created.tournament.id;
  await request.patch(`/api/admin/tournaments/${id}`, { data: { status: "registration_open" } }).then((r) => expect(r.ok()).toBe(true));

  const teamIds: string[] = [];
  for (let k = 0; k < opts.teams; k += 1) {
    const captain = playerPhone(opts.firstPlayer + k * 2);
    const partner = playerPhone(opts.firstPlayer + k * 2 + 1);
    await devLogin(request, { phone: captain });
    const team = await postJson<{ id: string }>(request, "/api/teams", { tournamentSlug: slug, name: `${opts.namePrefix ?? "Pair"} ${k + 1}`, partnerPhone: partner }, 201);
    await devLogin(request, { phone: partner });
    await postJson(request, `/api/teams/${team.id}/join`, {});
    await devLogin(request, { phone: captain });
    await postJson(request, `/api/tournaments/${slug}/register`, { teamId: team.id }, 201);
    teamIds.push(team.id);
  }

  await devLogin(request, { phone: ORGANIZER_PHONE });
  if (!opts.leaveOpen) await request.patch(`/api/admin/tournaments/${id}`, { data: { status: "registration_closed" } }).then((r) => expect(r.ok()).toBe(true));
  await request.post("/api/auth/logout");
  return { id, slug, name, teamIds };
}

/**
 * Take a closed event live: the Lucra mock's console creates its tournament
 * with the whole roster entered (what a Lucra representative and eight SDK
 * joins would have produced), the draw is committed, and the status moves to
 * live. Signs in as the organizer and stays signed in.
 */
export async function goLive(request: APIRequestContext, event: { id: string }, draw: Record<string, unknown> = {}): Promise<void> {
  await devLogin(request, { phone: ORGANIZER_PHONE });
  await request.patch(`/api/admin/tournaments/${event.id}`, { data: { status: "registration_closed" } });
  // 201 when the mock did not know the event; 200 when it seeded it from the database at first use (it still enters the roster).
  const mock = await postJson<{ participants: number; unlinked: unknown[] }>(request, "/api/rest/_mock/tournaments", { tournamentId: event.id, enterRoster: true }, [200, 201]);
  expect(mock.unlinked).toEqual([]);
  await postJson(request, `/api/admin/tournaments/${event.id}/draw`, { stage: "pools", courts: 2, ...draw }, 201);
  await request.patch(`/api/admin/tournaments/${event.id}`, { data: { status: "live" } }).then(async (r) => expect(r.ok(), await r.text()).toBe(true));
}

/** A member of `teamId` submits `sets` (own points first) for `matchId`. */
export async function submitAs(request: APIRequestContext, member: { userId: string }, matchId: string, sets: Array<[number, number]>): Promise<{ outcome: string }> {
  await devLogin(request, { userId: member.userId });
  return postJson<{ outcome: string }>(request, `/api/matches/${matchId}/scores`, { sets: sets.map(([usPoints, themPoints], i) => ({ setNumber: i + 1, usPoints, themPoints })) }, 201);
}

/** Both teams agree on a scoreline given from team A's side; returns the outcome of the second submission. */
export async function agreeOn(request: APIRequestContext, m: MatchRef, setsFromA: Array<[number, number]>): Promise<string> {
  const a = m.teamA?.members[0];
  const b = m.teamB?.members[0];
  if (!a || !b) throw new Error("match is missing a team");
  await submitAs(request, a, m.match.id, setsFromA);
  const second = await submitAs(request, b, m.match.id, setsFromA.map(([x, y]) => [y, x] as [number, number]));
  return second.outcome;
}
