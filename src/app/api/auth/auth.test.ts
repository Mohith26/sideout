import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as logout } from "@/app/api/auth/logout/route";
import { POST as requestCode } from "@/app/api/auth/request-code/route";
import { POST as verify } from "@/app/api/auth/verify/route";
import { POST as devLogin } from "@/app/api/dev/login/route.dev";
import { GET as me } from "@/app/api/me/route";
import { authCodes, users } from "@/db/schema";
import { okEnvelopeSchema } from "@/lib/api";
import { env } from "@/env";
import { CODE_TTL_MS, REQUEST_CODE_LIMITS } from "@/server/auth/codes";
import { createTestApp, expectFailure, type TestApp } from "@/test/routes";
import { z } from "zod";

const requestCodeData = z.object({ expiresAt: z.number(), devCode: z.string().regex(/^\d{6}$/) });
const verifyData = z.object({ user: z.object({ id: z.string(), displayName: z.string(), phoneE164: z.string().nullable(), role: z.string() }), created: z.boolean() });

describe("phone sign-in", () => {
  let app: TestApp;
  beforeEach(() => {
    app = createTestApp();
  });
  afterEach(() => {
    vi.useRealTimers();
    app.close();
  });

  /** The limiters refill on the wall clock; a budget drained to its last token must not refill mid-test. */
  const freezeClock = () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now());
  };

  async function issue(phone: string): Promise<string> {
    const res = await app.call(requestCode, "/api/auth/request-code", { method: "POST", body: { phone } });
    expect(res.status).toBe(200);
    return okEnvelopeSchema(requestCodeData).parse(res.body).data.devCode;
  }

  it("rejects a malformed phone with the failure envelope", async () => {
    const res = await app.call(requestCode, "/api/auth/request-code", { method: "POST", body: { phone: "not a phone" } });
    const error = expectFailure(res, 400, "bad_request");
    expect(error.detail).toMatchObject({ issues: [{ path: "phone" }] });
    const malformed = await app.call(requestCode, "/api/auth/request-code", { method: "POST", rawBody: "{not json" });
    expectFailure(malformed, 400, "bad_request");
  });

  it("issues a hashed code, returns it outside production, and never stores the plaintext", async () => {
    const code = await issue("+1 (555) 020-0001");
    const rows = app.conn.db.select().from(authCodes).where(eq(authCodes.phoneE164, "+15550200001")).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.codeHash).not.toContain(code);
    expect(rows[0]?.consumedAt).toBeNull();
  });

  it("refuses a wrong code without revealing whether the phone is known, and counts the attempt", async () => {
    await issue("+15550200002");
    const res = await app.call(verify, "/api/auth/verify", { method: "POST", body: { phone: "+15550200002", code: "000000" } });
    const error = expectFailure(res, 401, "unauthorized");
    expect(error.message).not.toMatch(/unknown|not found|exist/i);
    expect(app.conn.db.select().from(authCodes).where(eq(authCodes.phoneE164, "+15550200002")).get()?.attempts).toBe(1);
    // A phone with no code at all gets the same answer.
    const nothing = await app.call(verify, "/api/auth/verify", { method: "POST", body: { phone: "+15550200003", code: "123456" } });
    expect(expectFailure(nothing, 401, "unauthorized").message).toBe(error.message);
  });

  it("creates the account on first sign-in once a display name is given, and sets a HttpOnly Lax cookie", async () => {
    const code = await issue("+15550200004");
    const noName = await app.call(verify, "/api/auth/verify", { method: "POST", body: { phone: "+15550200004", code } });
    expect(expectFailure(noName, 400, "bad_request").detail).toEqual({ code: "display_name_required" });

    const res = await app.call(verify, "/api/auth/verify", { method: "POST", body: { phone: "+15550200004", code, displayName: "Sam Rivera" } });
    expect(res.status).toBe(201);
    const { data } = okEnvelopeSchema(verifyData).parse(res.body);
    expect(data).toMatchObject({ created: true, user: { displayName: "Sam Rivera", phoneE164: "+15550200004", role: "player" } });
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/sideout_session=v1\./);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).not.toMatch(/Secure/i);
    expect(res.headers.get("cache-control")).toBe("no-store");

    expect(app.conn.db.select().from(users).where(eq(users.id, data.user.id)).get()?.role).toBe("player");
    expect(app.audits(data.user.id).map((a) => a.action)).toEqual(["user.created", "user.signed_in"]);
    expect(app.conn.db.select().from(authCodes).where(eq(authCodes.phoneE164, "+15550200004")).get()?.consumedAt).not.toBeNull();

    // The cookie is a real session.
    const profile = await app.call(me, "/api/me", { cookie: `sideout_session=${res.sessionCookie}` });
    expect(profile.status).toBe(200);
    expect((profile.body as { data: { user: { id: string } } }).data.user.id).toBe(data.user.id);

    // A consumed code cannot be replayed.
    const replay = await app.call(verify, "/api/auth/verify", { method: "POST", body: { phone: "+15550200004", code } });
    expectFailure(replay, 401, "unauthorized");
  });

  it("signs an existing seeded player in without creating anything", async () => {
    const player = app.player();
    const phone = player.phoneE164 ?? "";
    const code = await issue(phone);
    const res = await app.call(verify, "/api/auth/verify", { method: "POST", body: { phone, code } });
    expect(res.status).toBe(200);
    const { data } = okEnvelopeSchema(verifyData).parse(res.body);
    expect(data).toMatchObject({ created: false, user: { id: player.id } });
    expect(app.conn.db.select().from(users).all()).toHaveLength(app.data.users.length);
    expect(app.audits(player.id, "user.signed_in")).toHaveLength(1);
  });

  it("marks the cookie Secure when the request arrived over https", async () => {
    const code = await issue("+15550200006");
    const res = await app.call(verify, "/api/auth/verify", {
      method: "POST",
      body: { phone: "+15550200006", code, displayName: "Secure Sam" },
      headers: { "x-forwarded-proto": "https" },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("set-cookie")).toMatch(/; Secure/i);
  });

  it("rate-limits code requests per phone", async () => {
    for (let i = 0; i < 3; i += 1) await issue("+15550200005");
    const res = await app.call(requestCode, "/api/auth/request-code", { method: "POST", body: { phone: "+15550200005" } });
    const error = expectFailure(res, 429, "rate_limited");
    expect(error.detail).toMatchObject({ retryAfterMs: expect.any(Number) });
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("caps issuance process-wide, so a spoofed x-forwarded-for and a fresh phone per request buy nothing", async () => {
    freezeClock();
    // No proxy is declared in the test environment, so the header is not evidence of an address
    // and never opens a per-address bucket; the global bucket is what stops the flood.
    const spoofed = (i: number) => ({ "x-forwarded-for": `198.51.100.${i % 250}, 10.0.0.1` });
    for (let i = 0; i < 5; i += 1) {
      const res = await app.call(requestCode, "/api/auth/request-code", { method: "POST", body: { phone: `+1555030${String(i).padStart(4, "0")}` }, headers: spoofed(i) });
      expect(res.status).toBe(200);
    }
    expect(REQUEST_CODE_LIMITS.perAddress.size()).toBe(0);
    while (REQUEST_CODE_LIMITS.global.take("*").allowed) {
      // Drain what the flood would have spent.
    }
    const refused = await app.call(requestCode, "/api/auth/request-code", { method: "POST", body: { phone: "+15550309999" }, headers: spoofed(99) });
    expectFailure(refused, 429, "rate_limited");
    expect(app.conn.db.select().from(authCodes).where(eq(authCodes.phoneE164, "+15550309999")).all()).toEqual([]);
  });

  it("charges the process-wide budget only for a code it actually issues", async () => {
    freezeClock();
    // A phone the narrower limit already refuses must not spend the shared budget on its retries.
    const throttled = "+15550400001";
    for (let i = 0; i < 3; i += 1) REQUEST_CODE_LIMITS.perPhone.take(throttled);
    for (let i = 1; i < env.AUTH_CODE_GLOBAL_CAP; i += 1) REQUEST_CODE_LIMITS.global.take("*");
    for (let i = 0; i < 5; i += 1) {
      expectFailure(await app.call(requestCode, "/api/auth/request-code", { method: "POST", body: { phone: throttled } }), 429, "rate_limited");
    }
    // The single token left still goes to the next legitimate caller.
    expect((await app.call(requestCode, "/api/auth/request-code", { method: "POST", body: { phone: "+15550400002" } })).status).toBe(200);
    expectFailure(await app.call(requestCode, "/api/auth/request-code", { method: "POST", body: { phone: "+15550400003" } }), 429, "rate_limited");
  });

  it("drops consumed and expired codes whenever a new one is issued", async () => {
    const phone = "+15550200007";
    const code = await issue(phone);
    await app.call(verify, "/api/auth/verify", { method: "POST", body: { phone, code, displayName: "Tidy Tess" } });
    expect(app.conn.db.select().from(authCodes).where(eq(authCodes.phoneE164, phone)).get()?.consumedAt).not.toBeNull();
    // Issuing for anyone sweeps the consumed row.
    await issue("+15550200008");
    expect(app.conn.db.select({ phone: authCodes.phoneE164 }).from(authCodes).all()).toEqual([{ phone: "+15550200008" }]);
    // ...and an expired one.
    app.conn.db.update(authCodes).set({ expiresAt: 1 }).where(eq(authCodes.phoneE164, "+15550200008")).run();
    await issue("+15550200009");
    const remaining = app.conn.db.select().from(authCodes).all();
    expect(remaining.map((r) => r.phoneE164)).toEqual(["+15550200009"]);
    expect(remaining[0]?.expiresAt).toBeGreaterThan(Date.now() + CODE_TTL_MS - 60_000);
  });

  it("rejects a tampered or foreign cookie", async () => {
    const good = app.cookieFor(app.player().id);
    const tampered = good.slice(0, -4) + "AAAA";
    expectFailure(await app.call(me, "/api/me", { cookie: tampered }), 401, "unauthorized");
    expectFailure(await app.call(me, "/api/me", { cookie: "sideout_session=v1.garbage" }), 401, "unauthorized");
    expectFailure(await app.call(me, "/api/me"), 401, "unauthorized");
  });

  it("logs out by clearing the cookie", async () => {
    const res = await app.call(logout, "/api/auth/logout", { method: "POST", cookie: app.cookieFor(app.player().id) });
    expect(res.status).toBe(200);
    expect(res.sessionCookie).toBe("");
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
  });

  it("dev login signs in as a seeded user by id outside production", async () => {
    const organizer = app.organizer();
    const res = await app.call(devLogin, "/api/dev/login", { method: "POST", body: { userId: organizer.id } });
    expect(res.status).toBe(200);
    expect(res.sessionCookie).toMatch(/^v1\./);
    const profile = await app.call(me, "/api/me", { cookie: `sideout_session=${res.sessionCookie}` });
    expect((profile.body as { data: { user: { role: string } } }).data.user.role).toBe("organizer");
    expectFailure(await app.call(devLogin, "/api/dev/login", { method: "POST", body: { userId: "nope" } }), 404, "not_found");
    expectFailure(await app.call(devLogin, "/api/dev/login", { method: "POST", body: {} }), 400, "bad_request");
    expectFailure(await app.call(devLogin, "/api/dev/login", { method: "POST", body: { userId: organizer.id, phone: organizer.phoneE164 } }), 400, "bad_request");
    const byPhone = await app.call(devLogin, "/api/dev/login", { method: "POST", body: { phone: organizer.phoneE164 } });
    expect(byPhone.status).toBe(200);
    expect((byPhone.body as { data: { user: { id: string } } }).data.user.id).toBe(organizer.id);
    expect(app.audits(organizer.id, "user.signed_in")[0]?.detailJson).toContain("dev_login");
  });
});
