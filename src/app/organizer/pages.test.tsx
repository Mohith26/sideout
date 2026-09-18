import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CloseTournamentPage from "@/app/organizer/events/[id]/close/page";
import DisputesPage from "@/app/organizer/disputes/page";
import { tournaments } from "@/db/schema";
import { env } from "@/env";
import { SLUGS } from "@/seed/build";
import { signSession } from "@/server/auth/session";
import { createTestApp, type TestApp } from "@/test/routes";

/**
 * The organizer console pages gate themselves: what they render for anyone
 * who is not an organizer must carry none of the console's data. A layout
 * cannot do this for them — Next renders a page segment into the RSC payload
 * whether or not its layout shows `children` — so each page is exercised
 * directly, as the server would, for an anonymous visitor, a player and an
 * organizer.
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

describe("organizer console pages", () => {
  let app: TestApp;
  beforeEach(() => {
    app = createTestApp();
    session.token = undefined;
  });
  afterEach(() => app.close());

  const signIn = (userId: string) => {
    session.token = signSession(userId, env.sessionSecret);
  };
  const disputed = () => {
    const m = app.data.matches.find((x) => x.status === "disputed");
    const consensus = app.data.matchConsensus.find((c) => c.matchId === m?.id);
    const teamA = app.data.teams.find((t) => t.id === m?.teamAId);
    const teamB = app.data.teams.find((t) => t.id === m?.teamBId);
    if (!m || !consensus?.disputedReason || !teamA || !teamB) throw new Error("seed has no disputed match");
    return { match: m, reason: consensus.disputedReason, teamA, teamB };
  };
  const renderDisputes = async () => renderToStaticMarkup(await DisputesPage());
  const renderClose = async (id: string) => renderToStaticMarkup(await CloseTournamentPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }));

  it("renders the dispute queue for an organizer only; everyone else gets the refusal and none of the data", async () => {
    const { reason, teamA, teamB } = disputed();
    const leaks = [reason, teamA.name, teamB.name, 'data-testid="dispute-card"', "Resolve as organizer"];

    const anonymous = await renderDisputes();
    expect(anonymous).toContain("Organizer access required");
    expect(anonymous).toContain("Sign in with an organizer account");
    for (const leak of leaks) expect(anonymous).not.toContain(leak);

    const player = app.player();
    signIn(player.id);
    const asPlayer = await renderDisputes();
    expect(asPlayer).toContain("Organizer access required");
    expect(asPlayer).toContain(`signed in as ${player.displayName}`);
    for (const leak of leaks) expect(asPlayer).not.toContain(leak);

    signIn(app.organizer().id);
    const asOrganizer = await renderDisputes();
    expect(asOrganizer).not.toContain("Organizer access required");
    for (const leak of leaks) expect(asOrganizer).toContain(leak);
  });

  it("renders the close flow for an organizer only, a draft included", async () => {
    const draftName = "Unannounced Invitational";
    app.conn.db
      .insert(tournaments)
      .values({ ...app.tournament(SLUGS.upcoming), id: "draft-1", slug: "unannounced-2027", name: draftName, status: "draft", lucraExternalId: "sideout-draft-1", createdAt: app.anchorMs })
      .run();
    const live = app.tournament(SLUGS.live);

    for (const id of ["draft-1", live.id]) {
      session.token = undefined;
      const anonymous = await renderClose(id);
      expect(anonymous).toContain("Organizer access required");
      for (const leak of [draftName, live.name, 'data-testid="blocking-list"', "Continue to confirm"]) expect(anonymous).not.toContain(leak);
    }

    signIn(app.player().id);
    expect(await renderClose("draft-1")).not.toContain(draftName);

    signIn(app.organizer().id);
    expect(await renderClose("draft-1")).toContain(`Close ${draftName}`);
    const asOrganizer = await renderClose(live.id);
    expect(asOrganizer).toContain(`Close ${live.name}`);
    expect(asOrganizer).toContain('data-testid="blocking-list"');
  });
});
