// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventForm, type EventFormOptions } from "@/components/organizer/EventForm";
import { ToastProvider } from "@/components/ui/Toast";
import { DIVISIONS, PRIZE_KINDS, SPONSOR_TIERS, TOURNAMENT_FORMATS, type Sponsor, type Tournament } from "@/db/schema";
import { buildSeed, DEFAULT_RNG_SEED, SLUGS } from "@/seed/build";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const data = buildSeed({ anchorMs: Date.UTC(2026, 5, 6, 7), rngSeed: DEFAULT_RNG_SEED });
const tournament = data.tournaments.find((t) => t.slug === SLUGS.upcoming) as Tournament;
const sponsors = data.sponsors.filter((s) => s.tournamentId === tournament.id) as Sponsor[];

const options: EventFormOptions = {
  formats: TOURNAMENT_FORMATS,
  divisions: DIVISIONS,
  prizeKinds: PRIZE_KINDS,
  tiers: SPONSOR_TIERS,
  charities: data.charities.map((c) => ({ id: c.id, name: c.name })),
  realMoneyEnabled: false,
  defaultGameId: tournament.lucraGameId,
  defaultTimeZone: tournament.venueTimezone,
  defaultCurrency: tournament.currency,
};

const sent: Array<{ method: string; body: Record<string, unknown> }> = [];

beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      sent.push({ method: String(init.method), body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true, data: { tournament: { id: tournament.id, name: tournament.name } } }), { status: 200 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderEdit() {
  return render(
    <ToastProvider>
      <EventForm mode="edit" options={options} tournament={tournament} sponsors={sponsors} locks={{ readOnly: false, beneficiary: false, currency: false, format: false, minTeams: 0 }} />
    </ToastProvider>,
  );
}

describe("EventForm", () => {
  it("only sends the sponsor list when it differs from the stored rows", async () => {
    expect(sponsors.length).toBeGreaterThan(0);
    renderEdit();

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.method).toBe("PATCH");
    expect(sent[0]?.body).not.toHaveProperty("sponsors");
    expect(sent[0]?.body.name).toBe(tournament.name);

    const first = sponsors[0] as Sponsor;
    fireEvent.change(screen.getAllByLabelText("Sponsor")[0] as HTMLElement, { target: { value: `${first.name} Foundation` } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]?.body.sponsors).toEqual(
      sponsors.map((s) => ({
        id: s.id,
        name: s.id === first.id ? `${first.name} Foundation` : s.name,
        tier: s.tier,
        prizeContributionCents: s.prizeContributionCents,
        logoUrl: s.logoUrl,
        currency: s.currency,
      })),
    );

    fireEvent.click(screen.getByRole("button", { name: `Remove ${first.name} Foundation` }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(sent).toHaveLength(3));
    expect((sent[2]?.body.sponsors as unknown[]).length).toBe(sponsors.length - 1);
  });
});
