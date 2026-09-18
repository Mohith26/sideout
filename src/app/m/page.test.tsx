import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MatchPage from "@/app/m/[id]/page";
import { teamMembers } from "@/db/schema";
import { env } from "@/env";
import { fixedClock } from "@/lib/clock";
import { SLUGS } from "@/seed/build";
import { signSession } from "@/server/auth/session";
import { forfeitMatch } from "@/server/matches";
import { createTestApp, type TestApp } from "@/test/routes";

/**
 * The match page as the server renders it for each viewer of the seeded
 * disputed quarterfinal, before and after an organizer forfeit settles it:
 * the two readings are an open dispute only while the match itself says so.
 */

const session = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session.token ? { value: session.token } : undefined) }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const OPEN_COPY = "The organizer will settle it with both teams; nothing is final until then.";
const SETTLED_COPY = "settled this match by forfeit; the readings below are kept as history and neither is the result.";
const CTA = "Resolve in the dispute queue";

describe("match page: a disputed match and its forfeit", () => {
  let app: TestApp;
  const clock = fixedClock(0);
  beforeEach(() => {
    app = createTestApp();
    clock.set(app.anchorMs + 23 * 3_600_000);
    session.token = undefined;
  });
  afterEach(() => app.close());

  const signIn = (userId: string) => {
    session.token = signSession(userId, env.sessionSecret);
  };
  const render = async (id: string) => renderToStaticMarkup(await MatchPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }));
  const disputed = () => {
    const live = app.tournament(SLUGS.live);
    const m = app.data.matches.find((x) => x.tournamentId === live.id && x.status === "disputed");
    if (!m?.teamAId || !m.teamBId) throw new Error("seed has no disputed match with both teams");
    const member = app.conn.db.select({ userId: teamMembers.userId }).from(teamMembers).where(eq(teamMembers.teamId, m.teamAId)).get();
    if (!member) throw new Error("team A has no member");
    return { match: m, memberId: member.userId };
  };

  it("shows the open dispute's two readings to a team member and, with the queue link, to an organizer", async () => {
    const { match, memberId } = disputed();
    const organizer = app.organizer();

    signIn(organizer.id);
    const asOrganizer = await render(match.id);
    expect(asOrganizer).toContain('data-testid="dispute-compare"');
    expect(asOrganizer).toContain(OPEN_COPY);
    expect(asOrganizer).toContain(CTA);
    expect(asOrganizer).not.toContain(SETTLED_COPY);

    signIn(memberId);
    const asMember = await render(match.id);
    expect(asMember).toContain('data-testid="dispute-compare"');
    expect(asMember).toContain(OPEN_COPY);
    expect(asMember).not.toContain(CTA);

    session.token = undefined;
    const asPublic = await render(match.id);
    expect(asPublic).not.toContain('data-testid="dispute-compare"');
    expect(asPublic).not.toContain(OPEN_COPY);
  });

  it("after an organizer forfeit, keeps the two readings as history with no open dispute and no queue link", async () => {
    const { match, memberId } = disputed();
    const organizer = app.organizer();
    forfeitMatch(match.id, match.teamAId ?? "", { kind: "organizer", userId: organizer.id }, clock);

    signIn(organizer.id);
    const asOrganizer = await render(match.id);
    expect(asOrganizer).toContain('data-testid="dispute-compare"');
    expect(asOrganizer).toContain('data-testid="settled-by-forfeit"');
    expect(asOrganizer).toContain(`The organizer (${organizer.displayName}) ${SETTLED_COPY}`);
    expect(asOrganizer).not.toContain(OPEN_COPY);
    expect(asOrganizer).not.toContain(CTA);
    expect(asOrganizer).toContain(">Forfeit<");
    expect(asOrganizer).not.toContain('data-testid="submit-panel"');

    signIn(memberId);
    const asMember = await render(match.id);
    expect(asMember).toContain('data-testid="settled-by-forfeit"');
    expect(asMember).toContain("Your team");
    expect(asMember).not.toContain(OPEN_COPY);
    expect(asMember).not.toContain(CTA);
    expect(asMember).not.toContain('data-testid="submit-panel"');

    session.token = undefined;
    const asPublic = await render(match.id);
    expect(asPublic).toContain(">Forfeit<");
    expect(asPublic).not.toContain('data-testid="dispute-compare"');
    expect(asPublic).not.toContain(SETTLED_COPY);
  });
});
