import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as bindRoute } from "@/app/api/me/lucra/bind/route";
import { POST as linkRoute } from "@/app/api/me/lucra/link/route";
import { POST as sdkRoute } from "@/app/api/rest/%5Fmock/sdk/route.mock";
import { GET as entryRoute } from "@/app/api/tournaments/[slug]/lucra/entry/route";
import { lucraLinks, teamMembers, teams, tournaments, users, webhookEvents } from "@/db/schema";
import type { ApiEnvelope } from "@/lib/api";
import { SLUGS, type SeedDataset } from "@/seed/build";
import { getLucra, mockLucraUserId } from "@/server/lucra";
import { createTestApp, expectFailure, type TestApp } from "@/test/routes";

type Envelope<T> = ApiEnvelope<T>;
type SdkUser = { id: string; username: string; balance: number; accountStatus: string; metadata: Record<string, string> };
type Bind = { externalId: string; lucraUserId: string | null; bound: boolean; source: string | null; reason: string | null };
type Entry = { matchup: { id: string | null }; players: Array<{ userId: string; you: boolean; linked: boolean; entered: boolean | null }>; externalId: string | null; complete: boolean; readBackAt: number | null };

/**
 * The server half of the browser SDK stand-in (`POST /api/rest/_mock/sdk`),
 * the bind that records a Lucra user id only from Lucra's side, and the
 * registration step's entry read-back. Every state change is asserted on the
 * rows the webhook receiver wrote, never on what the route answered.
 */
describe("phase 4b Lucra routes", () => {
  let app: TestApp;
  let logs: ReturnType<typeof vi.spyOn>[] = [];

  beforeEach(() => {
    app = createTestApp();
    logs = [vi.spyOn(console, "warn").mockImplementation(() => undefined), vi.spyOn(console, "error").mockImplementation(() => undefined), vi.spyOn(process.stdout, "write").mockImplementation(() => true)];
  });
  afterEach(() => {
    for (const l of logs) l.mockRestore();
    app.close();
  });

  const linkFor = (userId: string) => app.conn.db.select().from(lucraLinks).where(eq(lucraLinks.userId, userId)).get();
  const playerWith = (state: SeedDataset["lucraLinks"][number]["verificationState"]) => {
    const seeded = app.data.lucraLinks.find((l) => l.verificationState === state);
    const link = seeded ? linkFor(seeded.userId) : undefined;
    const user = app.data.users.find((u) => u.id === link?.userId);
    if (!link || !user) throw new Error(`seed has no ${state} player`);
    return { link, user };
  };
  const sdk = async <T>(cookie: string, body: unknown) => app.call<Envelope<T>>(sdkRoute, "/api/rest/_mock/sdk", { method: "POST", body, cookie });
  const okData = <T>(res: { status: number; body: Envelope<T> }): T => {
    if (!res.body.ok) throw new Error(`expected ok, got ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body.data;
  };

  describe("POST /api/rest/_mock/sdk", () => {
    it("is session-scoped: no session is 401, and an unknown action is refused", async () => {
      expectFailure(await sdk("", { action: "session" }), 401, "unauthorized");
      expectFailure(await sdk(app.cookieFor(app.player().id), { action: "nope" }), 400, "bad_request");
      expectFailure(await sdk(app.cookieFor(app.player().id), { action: "deposit", amountCents: -5 }), 400, "bad_request");
    });

    it("signs a seeded player in as the mock account the seed built, deterministically per verification state", async () => {
      for (const [state, status] of [
        ["verified", "VERIFIED"],
        ["not_allowed", "BLOCKED"],
        ["demographics_missing", "UNVERIFIED"],
        ["unverified", "UNVERIFIED"],
      ] as const) {
        const { user, link } = playerWith(state);
        const cookie = app.cookieFor(user.id);
        const before = okData(await sdk<{ user: SdkUser | null }>(cookie, { action: "session" }));
        expect(before.user?.accountStatus, state).toBe(status);
        const { user: account } = okData(await sdk<{ user: SdkUser }>(cookie, { action: "login" }));
        expect(account.accountStatus).toBe(status);
        expect(account.id).toBe(mockLucraUserId(link));
        expect(account.metadata.externalId).toBe(link.externalId);
        expect(JSON.stringify(account)).not.toMatch(/phone|\+1555/);
      }
    });

    it("a brand-new account is created on sign-in and announced by UserSignedUp, which records its id on the link by phone", async () => {
      const organizer = app.organizer(); // no link, no mock account in the seed
      const cookie = app.cookieFor(organizer.id);
      expect(okData(await sdk<{ user: SdkUser | null }>(cookie, { action: "session" })).user).toBeNull();
      okData(await app.call<Envelope<unknown>>(linkRoute, "/api/me/lucra/link", { method: "POST", body: {}, cookie }));
      const { user: account } = okData(await sdk<{ user: SdkUser }>(cookie, { action: "login" }));
      expect(account.accountStatus).toBe("UNVERIFIED");
      const delivered = app.conn.db.select().from(webhookEvents).all().filter((e) => e.eventType === "UserSignedUp");
      expect(delivered).toHaveLength(1);
      expect(linkFor(organizer.id)?.lucraUserId).toBe(account.id);
      // Signing in again finds the same account and sends nothing.
      expect(okData(await sdk<{ user: SdkUser }>(cookie, { action: "login" })).user.id).toBe(account.id);
      expect(app.conn.db.select().from(webhookEvents).all().filter((e) => e.eventType === "UserSignedUp")).toHaveLength(1);
    });

    it("userUpdated stores metadata, and only the caller's own external id", async () => {
      const { user } = playerWith("unverified");
      const cookie = app.cookieFor(user.id);
      okData(await sdk(cookie, { action: "login" }));
      const other = playerWith("verified").link;
      expectFailure(await sdk(cookie, { action: "userUpdated", metadata: { externalId: other.externalId } }), 409, "conflict");
      const mine = linkFor(user.id)!;
      const { user: account } = okData(await sdk<{ user: SdkUser }>(cookie, { action: "userUpdated", metadata: { externalId: mine.externalId, plan: "beach" } }));
      expect(account.metadata).toMatchObject({ externalId: mine.externalId, plan: "beach" });
    });

    it("the identity flow verifies an unverified account through UserKYCVerified, refuses a blocked one, and defers to the demographic form", async () => {
      const unverified = playerWith("unverified");
      let cookie = app.cookieFor(unverified.user.id);
      okData(await sdk(cookie, { action: "login" }));
      // An account Lucra already had sends no UserSignedUp; the gate's bind step records the id (as it does after every sign-in).
      okData(await app.call<Envelope<Bind>>(bindRoute, "/api/me/lucra/bind", { method: "POST", body: {}, cookie }));
      expect(linkFor(unverified.user.id)?.verificationState).toBe("unverified");
      const kyc = okData(await sdk<{ outcome: string; user: SdkUser }>(cookie, { action: "kyc" }));
      expect(kyc).toMatchObject({ outcome: "verified", user: { accountStatus: "VERIFIED" } });
      // The row changed through the receiver, keyed on the Lucra id the sign-in recorded.
      expect(linkFor(unverified.user.id)).toMatchObject({ verificationState: "verified", lucraUserId: kyc.user.id });
      expect(app.audits(unverified.user.id, "lucra.webhook.kyc_verified")).toHaveLength(1);
      // A second verification emits nothing new (documented: only the first fires).
      okData(await sdk(cookie, { action: "kyc" }));
      expect(app.conn.db.select().from(webhookEvents).all().filter((e) => e.eventType === "UserKYCVerified")).toHaveLength(1);

      const blocked = playerWith("not_allowed");
      cookie = app.cookieFor(blocked.user.id);
      okData(await sdk(cookie, { action: "login" }));
      expect(okData(await sdk<{ outcome: string; user: SdkUser }>(cookie, { action: "kyc" }))).toMatchObject({ outcome: "not_allowed", user: { accountStatus: "BLOCKED" } });
      expect(linkFor(blocked.user.id)?.verificationState).toBe("not_allowed");

      const demographics = playerWith("demographics_missing");
      cookie = app.cookieFor(demographics.user.id);
      okData(await sdk(cookie, { action: "login" }));
      okData(await app.call<Envelope<Bind>>(bindRoute, "/api/me/lucra/bind", { method: "POST", body: {}, cookie }));
      expect(okData(await sdk<{ outcome: string }>(cookie, { action: "kyc" })).outcome).toBe("demographics_required");
      expect(linkFor(demographics.user.id)?.verificationState).toBe("demographics_missing");
      const form = okData(await sdk<{ user: SdkUser }>(cookie, { action: "demographic" }));
      expect(form.user.accountStatus).toBe("AGE_ASSURED_VERIFIED");
      expect(linkFor(demographics.user.id)?.verificationState).toBe("verified");
    });

    it("deposits and withdrawals move the mock balance; an overdraft is the SDK's INSUFFICIENT_FUNDS", async () => {
      const { user } = playerWith("verified");
      const cookie = app.cookieFor(user.id);
      okData(await sdk(cookie, { action: "login" }));
      expect(okData(await sdk<{ user: SdkUser }>(cookie, { action: "deposit", amountCents: 2500 })).user.balance).toBe(25);
      const short = await sdk(cookie, { action: "withdraw", amountCents: 5000 });
      const err = expectFailure(short, 409, "conflict");
      expect(err.detail).toMatchObject({ code: "INSUFFICIENT_FUNDS" });
      expect(okData(await sdk<{ user: SdkUser }>(cookie, { action: "withdraw", amountCents: 1000 })).user.balance).toBe(15);
      expect(app.conn.db.select().from(webhookEvents).all().filter((e) => e.eventType === "FundsDeposited")).toHaveLength(1);
      const blocked = playerWith("not_allowed");
      okData(await sdk(app.cookieFor(blocked.user.id), { action: "login" }));
      expect(expectFailure(await sdk(app.cookieFor(blocked.user.id), { action: "deposit", amountCents: 100 }), 409, "conflict").detail).toMatchObject({ code: "API_ERROR" });
    });

    it("join applies the SDK's gates, then enrols through the mock and TournamentUserJoined", async () => {
      const open = app.tournament(SLUGS.upcoming);
      const mock = getLucra().mock!;
      const matchup = mock.listMatchups().find((m) => m.metadata.externalId === open.lucraExternalId)!;
      // A registered player of the open event whose auto-join the seed skipped (§7.5 divergence).
      const roster = app.conn.db.select({ userId: teamMembers.userId }).from(teamMembers).innerJoin(teams, eq(teams.id, teamMembers.teamId)).where(eq(teams.tournamentId, open.id)).all();
      const missing = roster.map((r) => linkFor(r.userId)!).find((l) => !matchup.participants.has(mockLucraUserId(l)) && l.verificationState === "verified");
      if (!missing) throw new Error("seed has no registered, verified player missing from the open matchup");
      const cookie = app.cookieFor(missing.userId);
      // No Lucra account at all (the organizer) is refused; the stand-in's own session gate covers "not signed in" client-side.
      expectFailure(await sdk(app.cookieFor(app.organizer().id), { action: "join", matchupId: matchup.id }), 401, "unauthorized");
      okData(await sdk(cookie, { action: "login" }));
      expect(expectFailure(await sdk(cookie, { action: "join", matchupId: "nope" }), 409, "conflict").detail).toMatchObject({ code: "API_ERROR" });
      expect(okData(await sdk<{ matchupId: string }>(cookie, { action: "join", matchupId: matchup.id }))).toEqual({ action: "join", matchupId: matchup.id });
      expect(mock.getMatchup(matchup.id)?.participants.has(mockLucraUserId(missing))).toBe(true);
      expect(app.conn.db.select().from(webhookEvents).all().filter((e) => e.eventType === "TournamentUserJoined")).toHaveLength(1);
      // Joining again is a no-op, not an error.
      okData(await sdk(cookie, { action: "join", matchupId: matchup.id }));

      const blocked = playerWith("not_allowed");
      okData(await sdk(app.cookieFor(blocked.user.id), { action: "login" }));
      expect(expectFailure(await sdk(app.cookieFor(blocked.user.id), { action: "join", matchupId: matchup.id }), 409, "conflict").detail).toMatchObject({ code: "API_ERROR" });
      const form = playerWith("demographics_missing");
      okData(await sdk(app.cookieFor(form.user.id), { action: "login" }));
      expect(expectFailure(await sdk(app.cookieFor(form.user.id), { action: "join", matchupId: matchup.id }), 409, "conflict").detail).toMatchObject({ code: "DEMOGRAPHIC_INFORMATION_MISSING" });

      const view = okData(await sdk<{ tournament: { title: string; participants: number; you: unknown } }>(cookie, { action: "tournament", matchupId: matchup.id }));
      expect(view.tournament).toMatchObject({ title: open.name, participants: mock.getMatchup(matchup.id)?.participants.size });
      expect(view.tournament.you).not.toBeNull();
    });
  });

  describe("POST /api/me/lucra/bind", () => {
    it("records the id the mock vouches for, never a claimed or contradicting one, and is idempotent", async () => {
      const { user } = playerWith("unverified");
      const cookie = app.cookieFor(user.id);
      expectFailure(await app.call(bindRoute, "/api/me/lucra/bind", { method: "POST", body: {} }), 401, "unauthorized");
      expectFailure(await app.call(bindRoute, "/api/me/lucra/bind", { method: "POST", body: { lucraUserId: "x", extra: 1 }, cookie }), 400, "bad_request");
      const before = linkFor(user.id)!;
      expect(before.lucraUserId).toBeNull();
      const expected = mockLucraUserId(before);
      // The mock knows this seeded account already, so the read is enough — no client id needed.
      const bound = okData(await app.call<Envelope<Bind>>(bindRoute, "/api/me/lucra/bind", { method: "POST", body: {}, cookie }));
      expect(bound).toMatchObject({ bound: true, source: "mock", lucraUserId: expected, externalId: before.externalId });
      expect(linkFor(user.id)?.lucraUserId).toBe(expected);
      expect(app.audits(user.id, "lucra.link_updated")).toHaveLength(1);
      // Again: already bound; a hint that disagrees is refused.
      expect(okData(await app.call<Envelope<Bind>>(bindRoute, "/api/me/lucra/bind", { method: "POST", body: { lucraUserId: expected }, cookie }))).toMatchObject({ bound: true, source: "already_bound" });
      expectFailure(await app.call(bindRoute, "/api/me/lucra/bind", { method: "POST", body: { lucraUserId: "someone-else" }, cookie }), 409, "conflict");
      expect(app.audits(user.id, "lucra.link_updated")).toHaveLength(1);
    });

    it("a hint the mock contradicts is refused before anything is written; a user Lucra cannot see yet is deferred", async () => {
      const { user, link } = playerWith("unverified");
      const cookie = app.cookieFor(user.id);
      expectFailure(await app.call(bindRoute, "/api/me/lucra/bind", { method: "POST", body: { lucraUserId: "not-mine" }, cookie }), 409, "conflict");
      expect(linkFor(user.id)?.lucraUserId).toBeNull();
      // Take the mock account away: nothing vouches, so the bind waits for a webhook or the read-back.
      const mock = getLucra().mock!;
      const seeded = mock.state().users.filter((u) => u.id !== mockLucraUserId(link));
      const matchups = mock.listMatchups().map((m) => ({ ...m, participants: [...m.participants.keys()].filter((id) => id !== mockLucraUserId(link)) }));
      mock.reset();
      mock.seed({ users: seeded, matchups });
      const deferred = okData(await app.call<Envelope<Bind>>(bindRoute, "/api/me/lucra/bind", { method: "POST", body: {}, cookie }));
      expect(deferred).toMatchObject({ bound: false, source: null, reason: "not_visible_yet", lucraUserId: null });
      expect(linkFor(user.id)?.lucraUserId).toBeNull();
      // A player with no link yet gets one minted by the bind itself.
      const organizer = app.organizer();
      const minted = okData(await app.call<Envelope<Bind>>(bindRoute, "/api/me/lucra/bind", { method: "POST", body: {}, cookie: app.cookieFor(organizer.id) }));
      expect(minted.externalId).toMatch(/^[0-9a-f-]{36}$/);
      expect(minted.bound).toBe(false);
    });

    it("never moves a Lucra id another link already holds", async () => {
      const { user } = playerWith("unverified");
      const victim = app.conn.db.select().from(lucraLinks).all().find((l) => l.lucraUserId !== null && l.userId !== user.id)!;
      // Make the mock report the victim's Lucra account for this player's phone.
      const phone = app.conn.db.select({ phone: users.phoneE164 }).from(users).where(eq(users.id, user.id)).get()?.phone ?? "";
      const mock = getLucra().mock!;
      const mine = mock.findUserByPhone(phone)!;
      const theirs = mock.getUser(victim.lucraUserId!)!;
      mine.phoneNumber = null;
      theirs.phoneNumber = phone;
      expectFailure(await app.call(bindRoute, "/api/me/lucra/bind", { method: "POST", body: {}, cookie: app.cookieFor(user.id) }), 409, "conflict");
      expect(linkFor(user.id)?.lucraUserId).toBeNull();
      expect(linkFor(victim.userId)?.lucraUserId).toBe(victim.lucraUserId);
    });
  });

  describe("GET /api/tournaments/:slug/lucra/entry", () => {
    it("reports the verified matchup and who Lucra lists as entered, for a registered member only", async () => {
      const open = app.tournament(SLUGS.upcoming);
      const team = app.conn.db.select().from(teams).where(eq(teams.tournamentId, open.id)).all().find((t) => t.status === "registered")!;
      const members = app.conn.db.select({ userId: teamMembers.userId }).from(teamMembers).where(eq(teamMembers.teamId, team.id)).all();
      const me = members[0]!.userId;
      expectFailure(await app.call(entryRoute, `/api/tournaments/${open.slug}/lucra/entry`, { params: { slug: open.slug } }), 401, "unauthorized");
      expectFailure(await app.call(entryRoute, `/api/tournaments/${open.slug}/lucra/entry`, { params: { slug: open.slug }, cookie: app.cookieFor(app.organizer().id) }), 404, "not_found");
      const entry = okData(await app.call<Envelope<Entry>>(entryRoute, `/api/tournaments/${open.slug}/lucra/entry`, { params: { slug: open.slug }, cookie: app.cookieFor(me) }));
      expect(entry.matchup.id).not.toBeNull();
      expect(app.conn.db.select({ id: tournaments.lucraMatchupId }).from(tournaments).where(eq(tournaments.id, open.id)).get()?.id).toBe(entry.matchup.id);
      expect(entry.players).toHaveLength(2);
      expect(entry.players.find((p) => p.userId === me)?.you).toBe(true);
      expect(entry.players.every((p) => p.linked && p.entered !== null)).toBe(true);
      expect(entry.externalId).toBe(linkFor(me)?.externalId);
      expect(entry.readBackAt).not.toBeNull();
      // Only the caller's own external id leaves the server.
      const other = members[1]!.userId;
      expect(JSON.stringify(entry)).not.toContain(linkFor(other)?.externalId ?? "nope");
      // The seed skipped one registered player's auto-join: some roster is incomplete, and the read-back says so.
      const everyone = await Promise.all(
        app.conn.db
          .select()
          .from(teams)
          .where(eq(teams.tournamentId, open.id))
          .all()
          .filter((t) => t.status === "registered")
          .map(async (t) => {
            const uid = app.conn.db.select({ userId: teamMembers.userId }).from(teamMembers).where(eq(teamMembers.teamId, t.id)).get()!.userId;
            return okData(await app.call<Envelope<Entry>>(entryRoute, `/api/tournaments/${open.slug}/lucra/entry`, { params: { slug: open.slug }, cookie: app.cookieFor(uid) }));
          }),
      );
      expect(everyone.some((e) => e.complete)).toBe(true);
      expect(everyone.some((e) => !e.complete && e.players.some((p) => p.entered === false))).toBe(true);
    });
  });
});
