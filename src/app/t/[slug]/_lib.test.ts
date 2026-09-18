import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tournaments, users, type User } from "@/db/schema";
import { getTournamentSummaryBySlug } from "@/db/queries/tournaments";
import { SESSION_COOKIE } from "@/server/auth/session";
import { SLUGS } from "@/seed/build";
import { createTestApp, type TestApp } from "@/test/routes";
import { findVisibleTournament, requireTournament, visibleTo } from "./_lib";

/** The request cookies a server component would see; the test swaps the jar per case. */
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined) }),
}));

const DRAFT_SLUG = "unpublished-2027";
const NOT_FOUND = /NEXT_HTTP_ERROR_FALLBACK;404/;

describe("/t/[slug] visibility", () => {
  let app: TestApp;
  beforeEach(() => {
    app = createTestApp();
    jar.clear();
    app.conn.db
      .insert(tournaments)
      .values({ ...app.tournament(SLUGS.upcoming), id: "draft-1", slug: DRAFT_SLUG, status: "draft", lucraExternalId: "sideout-draft-1", createdAt: app.anchorMs })
      .run();
  });
  afterEach(() => app.close());

  const signInAs = (userId: string) => {
    const [, value] = app.cookieFor(userId).split("=");
    jar.set(SESSION_COOKIE, value ?? "");
  };
  const userRow = (userId: string): User => {
    const row = app.conn.db.select().from(users).where(eq(users.id, userId)).get();
    if (!row) throw new Error(`no user ${userId}`);
    return row;
  };

  it("shows a published event to everyone and a draft to organizers only", () => {
    const live = getTournamentSummaryBySlug(SLUGS.live);
    const draft = getTournamentSummaryBySlug(DRAFT_SLUG);
    expect(draft?.tournament.status).toBe("draft");
    const organizer = userRow(app.organizer().id);
    const player = userRow(app.player().id);
    expect([organizer.role, player.role]).toEqual(["organizer", "player"]);
    expect(visibleTo(live, null)).toBe(live);
    expect(visibleTo(live, player)).toBe(live);
    expect(visibleTo(draft, null)).toBeNull();
    expect(visibleTo(draft, player)).toBeNull();
    expect(visibleTo(draft, organizer)).toBe(draft);
    expect(visibleTo(null, organizer)).toBeNull();
  });

  it("resolves the viewer from the session cookie: anonymous and players get 404 for a draft", async () => {
    await expect(requireTournament(DRAFT_SLUG)).rejects.toThrow(NOT_FOUND);
    expect(await findVisibleTournament(DRAFT_SLUG)).toBeNull();
    signInAs(app.player().id);
    await expect(requireTournament(DRAFT_SLUG)).rejects.toThrow(NOT_FOUND);
    // A forged cookie is no session at all.
    jar.set(SESSION_COOKIE, "v1.forged.forged");
    await expect(requireTournament(DRAFT_SLUG)).rejects.toThrow(NOT_FOUND);
    await expect(requireTournament("no-such-event")).rejects.toThrow(NOT_FOUND);
  });

  it("lets an organizer session open the draft, and everyone open a published event", async () => {
    signInAs(app.organizer().id);
    expect((await requireTournament(DRAFT_SLUG)).tournament.slug).toBe(DRAFT_SLUG);
    expect((await findVisibleTournament(DRAFT_SLUG))?.tournament.status).toBe("draft");
    jar.clear();
    expect((await requireTournament(SLUGS.live)).tournament.slug).toBe(SLUGS.live);
    expect((await requireTournament(SLUGS.upcoming)).tournament.status).toBe("registration_open");
  });
});
