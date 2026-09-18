import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { POST as resetDemo } from "@/app/api/admin/demo/reset/route";
import { GET as listDemo, POST as demoLogin } from "@/app/api/auth/demo/route";
import { POST as requestCode } from "@/app/api/auth/request-code/route";
import { GET as health } from "@/app/health/route";
import { GET as me } from "@/app/api/me/route";
import { matches, scoreSubmissions, teams, users } from "@/db/schema";
import { env } from "@/env";
import { okEnvelopeSchema } from "@/lib/api";
import { DEMO_SIGN_IN_LIMITS } from "@/server/auth/demo";
import { sessionForToken } from "@/server/auth/viewer";
import { DEMO_ACCOUNT_KEYS, DEMO_MATCH_BRACKET_POSITION } from "@/seed/demo";
import { createTestApp, expectFailure, type TestApp } from "@/test/routes";

/**
 * The public demo's account picker and reset (`DEMO_ACCOUNTS`). The env is
 * parsed once per process, so each case flips the switch on the singleton and
 * puts it back; the default (off) is what every other suite runs under.
 */

const RESET_TOKEN = "demo-reset-token-for-tests-0123456789abcdef";

const accountSchema = z.object({
  key: z.enum(DEMO_ACCOUNT_KEYS),
  userId: z.string(),
  displayName: z.string(),
  role: z.enum(["player", "organizer"]),
  tournament: z.object({ slug: z.string(), name: z.string() }),
  href: z.string().startsWith("/"),
  detail: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("match"), matchId: z.string(), matchStatus: z.string(), round: z.string(), teamName: z.string(), opponentName: z.string().nullable(), ownScorelineIn: z.boolean() }),
    z.object({ kind: z.literal("register"), teamId: z.string(), teamName: z.string(), teamStatus: z.string() }),
    z.object({ kind: z.literal("organizer") }),
    z.object({ kind: z.literal("lucra"), verificationState: z.string() }),
  ]),
});
const listSchema = okEnvelopeSchema(z.object({ accounts: z.array(accountSchema) }));
const signInSchema = okEnvelopeSchema(z.object({ user: z.object({ id: z.string(), displayName: z.string(), role: z.string() }), account: z.enum(DEMO_ACCOUNT_KEYS), href: z.string(), demo: z.literal(true) }));

function switchDemo(on: boolean, token: string | null = RESET_TOKEN) {
  Object.assign(env, { demoAccountsEnabled: on, DEMO_ACCOUNTS: on, NEXT_PUBLIC_DEMO_ACCOUNTS: on, DEMO_RESET_TOKEN: on && token ? token : undefined });
}

/** `/health` reports the flag in its data, or in the failure detail when the default database file is absent here. */
async function healthDemoFlag(app: TestApp): Promise<boolean> {
  const h = await app.call<{ ok: boolean; data?: { demoAccounts: boolean }; error?: { detail: { demoAccounts: boolean } } }>(health, "/health");
  return (h.body.data ?? h.body.error?.detail)?.demoAccounts ?? (() => { throw new Error("no flag"); })();
}

describe("demo accounts", () => {
  let app: TestApp;
  beforeEach(() => {
    app = createTestApp();
    for (const limiter of Object.values(DEMO_SIGN_IN_LIMITS)) limiter.reset();
  });
  afterEach(() => {
    switchDemo(false);
    app.close();
  });

  it("is absent while the switch is off: both routes and the reset answer 404, and /health says so", async () => {
    expect(env.demoAccountsEnabled).toBe(false);
    expectFailure(await app.call(listDemo, "/api/auth/demo"), 404, "not_found");
    expectFailure(await app.call(demoLogin, "/api/auth/demo", { method: "POST", body: { account: "organizer" } }), 404, "not_found");
    expectFailure(await app.call(resetDemo, "/api/admin/demo/reset", { method: "POST", headers: { authorization: `Bearer ${RESET_TOKEN}` } }), 404, "not_found");
    expect(await healthDemoFlag(app)).toBe(false);
  });

  it("lists the six curated seeded users with their live state when on", async () => {
    switchDemo(true);
    const res = await app.call(listDemo, "/api/auth/demo");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { accounts } = listSchema.parse(res.body).data;
    expect(accounts.map((a) => a.key)).toEqual([...DEMO_ACCOUNT_KEYS]);
    expect(new Set(accounts.map((a) => a.userId)).size).toBe(6);

    const [a, b, registrant, organizer, notAllowed, missing] = accounts;
    const live = app.tournament("sandbar-classic-2026");
    const match = app.conn.db.select().from(matches).where(eq(matches.tournamentId, live.id)).all().find((m) => m.bracketPosition === DEMO_MATCH_BRACKET_POSITION);
    expect(a?.detail).toMatchObject({ kind: "match", matchId: match?.id, matchStatus: "awaiting_scores", round: "Quarterfinal", ownScorelineIn: true });
    expect(b?.detail).toMatchObject({ kind: "match", matchId: match?.id, ownScorelineIn: false });
    expect(a?.href).toBe(`/m/${match?.id}`);
    expect(registrant?.detail).toMatchObject({ kind: "register", teamStatus: "forming" });
    expect(registrant?.href).toBe("/t/pier-9-open-2026/register");
    expect(organizer).toMatchObject({ role: "organizer", href: "/organizer/events", detail: { kind: "organizer" } });
    expect(notAllowed?.detail).toEqual({ kind: "lucra", verificationState: "not_allowed" });
    expect(missing?.detail).toEqual({ kind: "lucra", verificationState: "demographics_missing" });
    // The picker never carries a phone number or a Lucra id.
    expect(JSON.stringify(res.body)).not.toMatch(/\+1555|lucraUserId|externalId/);
    expect(await healthDemoFlag(app)).toBe(true);
  });

  it("signs in as a curated user through the normal session, marked demo, and audits it", async () => {
    switchDemo(true);
    const res = await app.call(demoLogin, "/api/auth/demo", { method: "POST", body: { account: "captain_b" } });
    expect(res.status).toBe(200);
    const { data } = signInSchema.parse(res.body);
    expect(data.account).toBe("captain_b");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(res.headers.get("cache-control")).toBe("no-store");

    // A real session for that user, carrying the demo marker.
    const session = sessionForToken(res.sessionCookie);
    expect(session?.user.id).toBe(data.user.id);
    expect(session?.via).toBe("demo");
    const profile = await app.call(me, "/api/me", { cookie: `sideout_session=${res.sessionCookie}` });
    expect(profile.status).toBe(200);

    // Audited on the user, naming the account and never a phone.
    const audits = app.audits(data.user.id, "auth.demo_sign_in");
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0]?.detailJson ?? "null")).toEqual({ account: "captain_b", method: "demo_accounts" });
    expect(audits[0]?.actorUserId).toBe(data.user.id);
    expect(app.audits(data.user.id, "user.signed_in")).toHaveLength(0);
    expect(app.conn.db.select().from(users).all()).toHaveLength(app.data.users.length);

    // The organizer lands in the console.
    const organizer = await app.call(demoLogin, "/api/auth/demo", { method: "POST", body: { account: "organizer" } });
    expect(signInSchema.parse(organizer.body).data).toMatchObject({ user: { role: "organizer" }, href: "/organizer/events" });
  });

  it("refuses unknown accounts, arbitrary user ids and phones", async () => {
    switchDemo(true);
    expectFailure(await app.call(demoLogin, "/api/auth/demo", { method: "POST", body: { account: "captain_c" } }), 400, "bad_request");
    expectFailure(await app.call(demoLogin, "/api/auth/demo", { method: "POST", body: { userId: app.organizer().id } }), 400, "bad_request");
    expectFailure(await app.call(demoLogin, "/api/auth/demo", { method: "POST", body: { phone: app.organizer().phoneE164 } }), 400, "bad_request");
    expectFailure(await app.call(demoLogin, "/api/auth/demo", { method: "POST", body: {} }), 400, "bad_request");
    expectFailure(await app.call(demoLogin, "/api/auth/demo", { method: "POST", rawBody: "nope" }), 400, "bad_request");
  });

  it("rate-limits per address when a proxy vouches for it, and process-wide otherwise", async () => {
    switchDemo(true);
    const hops = env.TRUSTED_PROXY_HOPS;
    Object.assign(env, { TRUSTED_PROXY_HOPS: 1 });
    try {
      const from = (ip: string) => ({ "x-forwarded-for": ip });
      for (let i = 0; i < 30; i += 1) expect((await app.call(demoLogin, "/api/auth/demo", { method: "POST", body: { account: "organizer" }, headers: from("203.0.113.7") })).status).toBe(200);
      const refused = await app.call(demoLogin, "/api/auth/demo", { method: "POST", body: { account: "organizer" }, headers: from("203.0.113.7") });
      const error = expectFailure(refused, 429, "rate_limited");
      expect(error.detail).toMatchObject({ retryAfterMs: expect.any(Number) });
      expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
      // Another address still gets in; a refused attempt is not audited.
      expect((await app.call(demoLogin, "/api/auth/demo", { method: "POST", body: { account: "organizer" }, headers: from("203.0.113.8") })).status).toBe(200);
      expect(app.audits(app.organizer().id, "auth.demo_sign_in")).toHaveLength(31);
    } finally {
      Object.assign(env, { TRUSTED_PROXY_HOPS: hops });
    }
    while (DEMO_SIGN_IN_LIMITS.global.take("*").allowed) {
      // Drain the process-wide budget.
    }
    expectFailure(await app.call(demoLogin, "/api/auth/demo", { method: "POST", body: { account: "organizer" } }), 429, "rate_limited");
  });

  it("leaves the phone-code sign-in exactly as it is", async () => {
    switchDemo(true);
    const res = await app.call(requestCode, "/api/auth/request-code", { method: "POST", body: { phone: app.player().phoneE164 } });
    expect(res.status).toBe(200);
    expect(okEnvelopeSchema(z.object({ expiresAt: z.number(), devCode: z.string() })).parse(res.body).data.devCode).toMatch(/^\d{6}$/);
  });

  describe("reset", () => {
    it("needs the bearer token: 503 while none is configured, 401 for a wrong or missing one", async () => {
      switchDemo(true, null);
      expectFailure(await app.call(resetDemo, "/api/admin/demo/reset", { method: "POST", headers: { authorization: `Bearer ${RESET_TOKEN}` } }), 503, "unavailable");
      switchDemo(true);
      expectFailure(await app.call(resetDemo, "/api/admin/demo/reset", { method: "POST" }), 401, "unauthorized");
      expectFailure(await app.call(resetDemo, "/api/admin/demo/reset", { method: "POST", headers: { authorization: "Bearer nope" } }), 401, "unauthorized");
      expectFailure(await app.call(resetDemo, "/api/admin/demo/reset", { method: "POST", headers: { authorization: `Bearer ${RESET_TOKEN}x` } }), 401, "unauthorized");
      // An organizer session is not a token.
      expectFailure(await app.call(resetDemo, "/api/admin/demo/reset", { method: "POST", cookie: app.cookieFor(app.organizer().id) }), 401, "unauthorized");
    });

    it("reseeds the live database in place with the token: a demo's changes are gone and the picker is back to its start", async () => {
      switchDemo(true);
      // Captain B answers captain A's scoreline through the demo, so the match leaves awaiting_scores.
      const before = listSchema.parse((await app.call(listDemo, "/api/auth/demo")).body).data.accounts;
      const match = before[0]?.detail.kind === "match" ? before[0].detail.matchId : "";
      const signedIn = await app.call(demoLogin, "/api/auth/demo", { method: "POST", body: { account: "captain_b" } });
      const teamB = app.conn.db.select().from(matches).where(eq(matches.id, match)).get()?.teamBId ?? "";
      app.conn.db.insert(scoreSubmissions).values({ id: "00000000-0000-7000-8000-000000000001", matchId: match, submittedByUserId: signInSchema.parse(signedIn.body).data.user.id, submittedForTeamId: teamB, payloadJson: "{}", payloadHash: "x", createdAt: Date.now(), supersededById: null }).run();
      app.conn.db.update(teams).set({ name: "Renamed by the demo" }).where(eq(teams.id, teamB)).run();
      expect(listSchema.parse((await app.call(listDemo, "/api/auth/demo")).body).data.accounts[1]?.detail).toMatchObject({ ownScorelineIn: true, teamName: "Renamed by the demo" });
      expect(app.audits(signInSchema.parse(signedIn.body).data.user.id, "auth.demo_sign_in")).toHaveLength(1);

      const res = await app.call(resetDemo, "/api/admin/demo/reset", { method: "POST", headers: { authorization: `Bearer ${RESET_TOKEN}` } });
      expect(res.status).toBe(200);
      const { data } = okEnvelopeSchema(z.object({ anchor: z.string(), counts: z.record(z.string(), z.number()), durationMs: z.number() })).parse(res.body);
      expect(new Date(data.anchor).getTime()).toBe(app.anchorMs);
      expect(data.counts.users).toBe(app.data.users.length);
      expect(data.counts.matches).toBe(app.data.matches.length);
      expect(res.headers.get("cache-control")).toBe("no-store");

      const after = listSchema.parse((await app.call(listDemo, "/api/auth/demo")).body).data.accounts;
      expect(after.map((a) => a.userId)).toEqual(before.map((a) => a.userId));
      expect(after[1]?.detail).toMatchObject({ kind: "match", matchStatus: "awaiting_scores", ownScorelineIn: false });
      expect(after[1]?.detail.kind === "match" && after[1].detail.teamName).not.toBe("Renamed by the demo");
      expect(app.conn.db.select().from(scoreSubmissions).where(eq(scoreSubmissions.id, "00000000-0000-7000-8000-000000000001")).get()).toBeUndefined();
      // The audit log is the seed's again: the demo sign-in row is gone with everything else.
      expect(app.audits(signInSchema.parse(signedIn.body).data.user.id, "auth.demo_sign_in")).toHaveLength(0);
      // A session issued before the reset still names a user that exists (same seeded ids for the same day).
      expect(sessionForToken(signedIn.sessionCookie)?.user.id).toBe(signInSchema.parse(signedIn.body).data.user.id);
    });
  });
});
