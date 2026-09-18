import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { users } from "@/db/schema";
import { SESSION_COOKIE } from "@/server/auth/session";
import { createTestApp, type TestApp } from "@/test/routes";
import { isConsoleViewer, requireOrganizerViewer } from "./_lib";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined) }),
}));

const NOT_FOUND = /NEXT_HTTP_ERROR_FALLBACK;404/;

describe("/organizer gate", () => {
  let app: TestApp;
  beforeEach(() => {
    app = createTestApp();
    jar.clear();
  });
  afterEach(() => app.close());

  const signInAs = (userId: string) => {
    const [, value] = app.cookieFor(userId).split("=");
    jar.set(SESSION_COOKIE, value ?? "");
  };

  it("admits organizers only", () => {
    const organizer = app.conn.db.select().from(users).where(eq(users.id, app.organizer().id)).get() ?? null;
    const player = app.conn.db.select().from(users).where(eq(users.id, app.player().id)).get() ?? null;
    expect(isConsoleViewer(organizer)).toBe(true);
    expect(isConsoleViewer(player)).toBe(false);
    expect(isConsoleViewer(null)).toBe(false);
  });

  it("answers 404 to anonymous visitors, players and forged cookies, and resolves an organizer", async () => {
    await expect(requireOrganizerViewer()).rejects.toThrow(NOT_FOUND);
    signInAs(app.player().id);
    await expect(requireOrganizerViewer()).rejects.toThrow(NOT_FOUND);
    jar.set(SESSION_COOKIE, "v1.forged.forged");
    await expect(requireOrganizerViewer()).rejects.toThrow(NOT_FOUND);
    signInAs(app.organizer().id);
    expect((await requireOrganizerViewer()).id).toBe(app.organizer().id);
  });
});
