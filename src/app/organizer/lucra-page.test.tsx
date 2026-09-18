import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TournamentLucraPage from "@/app/organizer/events/[id]/lucra/page";
import { ReconciliationView } from "@/components/organizer/ReconciliationView";
import { env } from "@/env";
import { SLUGS } from "@/seed/build";
import { signSession } from "@/server/auth/session";
import { getLucra, type ParticipantReconciliation } from "@/server/lucra";
import { createTestApp, type TestApp } from "@/test/routes";

/**
 * The organizer's reconciliation page: gated like the rest of the console,
 * rendered from Lucra's read-back, and honest when Lucra does not answer.
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

describe("ReconciliationView", () => {
  const base: ParticipantReconciliation = { tournamentId: "t", matchupId: "abcdef12-0000", lucraStatus: "OPEN", lucraParticipants: 3, matched: [], missing: [], unlinked: [], extra: [] };

  it("shows the four buckets with their counts and the divergence total", () => {
    const html = renderToStaticMarkup(
      <ReconciliationView
        readAtLabel="today"
        reconciliation={{
          ...base,
          matched: [{ userId: "u1", displayName: "Ana", teamId: "tm", teamName: "Marchetti / Hayashi", externalId: "ext-1", lucraUserId: "lu-1" }],
          missing: [{ userId: "u2", displayName: "Yui", teamId: "tm", teamName: "Marchetti / Hayashi", externalId: "ext-2" }],
          unlinked: [{ userId: "u3", displayName: "Omar", teamId: "tm2", teamName: "Ahmadi / El-Amin" }],
          extra: [{ lucraUserId: "lu-9", externalId: null, userName: "stranger" }],
        }}
      />,
    );
    expect(html).toContain('data-divergent="3"');
    expect(html).toContain('data-testid="reconciliation-missing" data-count="1"');
    expect(html).toContain('data-testid="reconciliation-unlinked" data-count="1"');
    expect(html).toContain('data-testid="reconciliation-extra" data-count="1"');
    expect(html).toContain('data-testid="reconciliation-matched" data-count="1"');
    for (const name of ["Ana", "Yui", "Omar", "stranger", "ext-1", "ext-2", "lu-9", "Not in Lucra", "No Lucra account", "Not on a team", "In Lucra"]) expect(html).toContain(name);
    expect(html).not.toContain("Lucra agrees with the roster");
  });

  it("says so when Lucra agrees with the roster", () => {
    const html = renderToStaticMarkup(<ReconciliationView readAtLabel="today" reconciliation={{ ...base, matched: [{ userId: "u1", displayName: "Ana", teamId: "tm", teamName: "T", externalId: "e", lucraUserId: "l" }] }} />);
    expect(html).toContain('data-divergent="0"');
    expect(html).toContain("Lucra agrees with the roster");
  });
});

describe("/organizer/events/[id]/lucra", () => {
  let app: TestApp;
  let logs: ReturnType<typeof vi.spyOn>[] = [];
  beforeEach(() => {
    app = createTestApp();
    session.token = undefined;
    logs = [vi.spyOn(console, "warn").mockImplementation(() => undefined), vi.spyOn(process.stdout, "write").mockImplementation(() => true)];
  });
  afterEach(() => {
    for (const l of logs) l.mockRestore();
    app.close();
  });
  const render = async (id: string) => renderToStaticMarkup(await TournamentLucraPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }));

  it("is organizer-only: anonymous and players get the console's 404", async () => {
    const t = app.tournament(SLUGS.upcoming);
    await expect(render(t.id)).rejects.toThrow("NEXT_NOT_FOUND");
    session.token = signSession(app.player().id, env.sessionSecret);
    await expect(render(t.id)).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("renders the read-back for an organizer: the seeded open event diverges by one missing and one extra", async () => {
    session.token = signSession(app.organizer().id, env.sessionSecret);
    const t = app.tournament(SLUGS.upcoming);
    const html = await render(t.id);
    expect(html).toContain("Lucra entry");
    expect(html).toContain(t.lucraExternalId);
    expect(html).toContain('data-testid="reconciliation-missing" data-count="1"');
    expect(html).toContain('data-testid="reconciliation-extra" data-count="1"');
    expect(html).toContain('data-testid="reconciliation-unlinked" data-count="0"');
    expect(html).toContain("Re-check");
    expect(html).toContain("Verify targeting");
    expect(html).toContain(`/admin/lucra?tournament=${t.id}`);
    expect(html).not.toContain("sideout-mock-backend-key");
  });

  it("stays up when Lucra does not answer, naming the failure instead of a table", async () => {
    session.token = signSession(app.organizer().id, env.sessionSecret);
    const t = app.tournament(SLUGS.upcoming);
    const mock = getLucra().mock!;
    const original = mock.handle.bind(mock);
    mock.handle = (req) => (req.path.startsWith("/api/rest/pool-tournament/") && req.method === "GET" ? { status: 503, body: { status: "failure", error: "down" } } : original(req));
    const html = await render(t.id);
    expect(html).toContain("Lucra did not answer");
    expect(html).not.toContain('data-testid="reconciliation"');
  });
});
