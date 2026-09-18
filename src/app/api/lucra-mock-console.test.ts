import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as createTournament } from "@/app/api/admin/tournaments/route";
import { POST as verifyRoute } from "@/app/api/admin/tournaments/[id]/lucra/verify/route";
import { POST as createMockTournamentRoute } from "@/app/api/rest/%5Fmock/tournaments/route.mock";
import { lucraLinks, teamMembers, teams, tournaments } from "@/db/schema";
import type { ApiEnvelope } from "@/lib/api";
import { uuidv7 } from "@/lib/uuid";
import { getLucra } from "@/server/lucra";
import { createTestApp, expectFailure, type TestApp } from "@/test/routes";

type Envelope<T> = ApiEnvelope<T>;
type Created = { matchupId: string; externalId: string; participants: number; unlinked: Array<{ userId: string }> };

const HOUR = 3_600_000;

/**
 * The organizer's stand-in for Lucra's console (mock builds only): an event
 * created after boot gets its matchup, its registered roster enters the way
 * the SDK would (webhooks and all), and the §7.3.4 verify then finds exactly
 * one. Refused for anyone but an organizer, and refused twice.
 */
describe("POST /api/rest/_mock/tournaments", () => {
  let app: TestApp;
  let organizerCookie: string;
  let logs: ReturnType<typeof vi.spyOn>[] = [];

  beforeEach(() => {
    app = createTestApp();
    organizerCookie = app.cookieFor(app.organizer().id);
    // The mock seeds itself from the database on first use: boot it now, so an event created below is one it never saw.
    getLucra();
    logs = [vi.spyOn(console, "warn").mockImplementation(() => undefined), vi.spyOn(console, "error").mockImplementation(() => undefined), vi.spyOn(process.stdout, "write").mockImplementation(() => true)];
  });
  afterEach(() => {
    for (const l of logs) l.mockRestore();
    app.close();
  });

  async function newEvent(): Promise<{ id: string; externalId: string }> {
    const res = await app.call<Envelope<{ tournament: { id: string; lucraExternalId: string } }>>(createTournament, "/api/admin/tournaments", {
      method: "POST",
      cookie: organizerCookie,
      body: {
        slug: "fresh-event-2027",
        name: "Fresh Event",
        beneficiaryId: app.data.charities[0]?.id ?? "",
        venueName: "Zuma Beach Courts",
        venueCity: "Malibu",
        venueState: "CA",
        venueTimezone: "America/Los_Angeles",
        startsAt: app.anchorMs + 60 * 24 * HOUR,
        endsAt: app.anchorMs + 60 * 24 * HOUR + 9 * HOUR,
        format: "single_elim",
        division: "open",
        maxTeams: 4,
        entryDonationCents: 0,
        fundraisingGoalCents: 100000,
      },
    });
    if (!res.body.ok) throw new Error(JSON.stringify(res.body));
    return { id: res.body.data.tournament.id, externalId: res.body.data.tournament.lucraExternalId };
  }

  /** Register `count` pairs of seeded players straight into the rows (the flow itself is covered by the teams tests). */
  function registerPairs(tournamentId: string, count: number, from = 0): string[] {
    const db = app.conn.db;
    const players = app.data.users.filter((u) => u.role === "player");
    const userIds: string[] = [];
    for (let k = 0; k < count; k += 1) {
      const teamId = uuidv7();
      db.insert(teams).values({ id: teamId, tournamentId, name: `Pair ${k + 1}`, status: "registered", seed: null, createdAt: app.anchorMs }).run();
      for (const slot of [0, 1]) {
        const user = players[from + k * 2 + slot];
        if (!user) throw new Error("not enough seeded players");
        db.insert(teamMembers).values({ id: uuidv7(), teamId, userId: user.id, role: slot === 0 ? "captain" : "player" }).run();
        userIds.push(user.id);
      }
    }
    return userIds;
  }

  it("is organizer-gated and validates its body", async () => {
    const { id } = await newEvent();
    expectFailure(await app.call(createMockTournamentRoute, "/api/rest/_mock/tournaments", { method: "POST", body: { tournamentId: id } }), 401, "unauthorized");
    expectFailure(await app.call(createMockTournamentRoute, "/api/rest/_mock/tournaments", { method: "POST", cookie: app.cookieFor(app.player().id), body: { tournamentId: id } }), 403, "forbidden");
    expectFailure(await app.call(createMockTournamentRoute, "/api/rest/_mock/tournaments", { method: "POST", cookie: organizerCookie, body: { tournamentId: id, extra: 1 } }), 400, "bad_request");
    expectFailure(await app.call(createMockTournamentRoute, "/api/rest/_mock/tournaments", { method: "POST", cookie: organizerCookie, body: { tournamentId: "nope" } }), 404, "not_found");
  });

  it("creates the matchup for an event the mock did not know, enters the linked roster with webhooks, and then verifies as exactly one", async () => {
    const { id, externalId } = await newEvent();
    const userIds = registerPairs(id, 2);
    const mock = getLucra().mock;
    if (!mock) throw new Error("mock mode");
    expect(mock.listMatchups().some((m) => m.metadata.externalId === externalId)).toBe(false);

    const res = await app.call<Envelope<Created>>(createMockTournamentRoute, "/api/rest/_mock/tournaments", { method: "POST", cookie: organizerCookie, body: { tournamentId: id, enterRoster: true } });
    expect(res.status).toBe(201);
    if (!res.body.ok) throw new Error(JSON.stringify(res.body));
    expect(res.body.data).toMatchObject({ externalId, created: true, participants: 4, unlinked: [] });
    const matchup = mock.getMatchup(res.body.data.matchupId);
    expect(matchup?.metadata.externalId).toBe(externalId);
    expect(matchup?.participants.size).toBe(4);

    // Each join went out as the mock's TournamentUserJoined and the receiver recorded the Lucra ids it echoed.
    for (const userId of userIds) {
      const link = app.conn.db.select().from(lucraLinks).where(eq(lucraLinks.userId, userId)).get();
      expect(link?.lucraUserId, userId).not.toBeNull();
    }

    // The §7.3.4 assertion now finds exactly one and caches it on the row.
    const verified = await app.call<Envelope<{ count: number; matchupId: string }>>(verifyRoute, `/api/admin/tournaments/${id}/lucra/verify`, { method: "POST", params: { id }, cookie: organizerCookie, body: {} });
    expect(verified.body.ok && verified.body.data.count).toBe(1);
    const row = app.conn.db.select().from(tournaments).where(eq(tournaments.id, id)).get();
    expect(row?.lucraMatchupId).toBe(res.body.data.matchupId);

    // Again is not a second tournament (rule 7.3.4 would refuse two under one externalId): the same matchup comes back, not created.
    const again = await app.call<Envelope<Created & { created: boolean }>>(createMockTournamentRoute, "/api/rest/_mock/tournaments", { method: "POST", cookie: organizerCookie, body: { tournamentId: id, enterRoster: true } });
    expect(again.status).toBe(200);
    expect(again.body.ok && again.body.data).toMatchObject({ matchupId: res.body.data.matchupId, created: false, participants: 4 });
    expect(mock.listMatchups().filter((m) => m.metadata.externalId === externalId)).toHaveLength(1);
  });

  it("without enterRoster the matchup is empty, and a player with no Lucra link is reported rather than invented", async () => {
    const { id } = await newEvent();
    const [first] = registerPairs(id, 1, 10);
    app.conn.db.delete(lucraLinks).where(eq(lucraLinks.userId, first ?? "")).run();
    const empty = await app.call<Envelope<Created>>(createMockTournamentRoute, "/api/rest/_mock/tournaments", { method: "POST", cookie: organizerCookie, body: { tournamentId: id } });
    expect(empty.body.ok && empty.body.data.participants).toBe(0);
    expect(empty.body.ok && empty.body.data.unlinked).toEqual([]);

    // Entering the roster on a second, linked-and-unlinked event: the unlinked player is named, the linked one joins.
    const mock = getLucra().mock;
    if (!mock) throw new Error("mock mode");
    const second = await app.call<Envelope<{ tournament: { id: string } }>>(createTournament, "/api/admin/tournaments", {
      method: "POST",
      cookie: organizerCookie,
      body: {
        slug: "second-event-2027",
        name: "Second Event",
        beneficiaryId: app.data.charities[0]?.id ?? "",
        venueName: "Zuma Beach Courts",
        venueCity: "Malibu",
        venueState: "CA",
        venueTimezone: "America/Los_Angeles",
        startsAt: app.anchorMs + 61 * 24 * HOUR,
        endsAt: app.anchorMs + 61 * 24 * HOUR + 9 * HOUR,
        format: "single_elim",
        division: "open",
        maxTeams: 4,
        entryDonationCents: 0,
        fundraisingGoalCents: 100000,
      },
    });
    if (!second.body.ok) throw new Error(JSON.stringify(second.body));
    const secondId = second.body.data.tournament.id;
    registerPairs(secondId, 1, 10);
    const entered = await app.call<Envelope<Created>>(createMockTournamentRoute, "/api/rest/_mock/tournaments", { method: "POST", cookie: organizerCookie, body: { tournamentId: secondId, enterRoster: true } });
    if (!entered.body.ok) throw new Error(JSON.stringify(entered.body));
    expect(entered.body.data.participants).toBe(1);
    expect(entered.body.data.unlinked.map((u) => u.userId)).toEqual([first]);
    expect(mock.getMatchup(entered.body.data.matchupId)?.participants.size).toBe(1);
  });
});
