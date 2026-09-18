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
type SponsorInput = Omit<Sponsor, "id" | "tournamentId"> & { id?: string };

/** The rows `replaceSponsors` would leave behind: known ids kept, new sponsors given one. */
function storedSponsors(inputs: SponsorInput[] | undefined, previous: Sponsor[]): Sponsor[] {
  if (!inputs) return previous;
  return inputs.map((s, i) => ({ ...s, id: s.id ?? `new-sponsor-${i}`, tournamentId: tournament.id }));
}

beforeEach(() => {
  sent.length = 0;
  let stored = sponsors;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      sent.push({ method: String(init.method), body });
      stored = storedSponsors(body.sponsors as SponsorInput[] | undefined, stored);
      return new Response(JSON.stringify({ ok: true, data: { tournament: { id: tournament.id, name: tournament.name }, sponsors: stored } }), { status: 200 });
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

function fillRequired() {
  const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
  type("Name", "Dune Cup");
  type("Venue", "North Jetty");
  type("City", "Oceanside");
  type("State", "CA");
  type("Starts", "2026-08-01T08:00");
  type("Ends", "2026-08-01T18:00");
  type("Entry donation per team", "75");
  type("Fundraising goal", "5000");
}

describe("EventForm", () => {
  it("creates a draft without a sponsor list until a sponsor is added", async () => {
    render(
      <ToastProvider>
        <EventForm mode="create" options={options} />
      </ToastProvider>,
    );
    fillRequired();
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.method).toBe("POST");
    expect(sent[0]?.body.name).toBe("Dune Cup");
    expect(sent[0]?.body).not.toHaveProperty("sponsors");

    fireEvent.click(screen.getByRole("button", { name: "Add sponsor" }));
    fireEvent.change(screen.getByLabelText("Sponsor"), { target: { value: "Tidewater Surf Co" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect((sent[1]?.body.sponsors as Array<{ name: string }>).map((s) => s.name)).toEqual(["Tidewater Surf Co"]);
  });

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

  it("learns a new sponsor's id from the save, so the next unchanged save sends no sponsors", async () => {
    renderEdit();
    fireEvent.click(screen.getByRole("button", { name: "Add sponsor" }));
    const inputs = screen.getAllByLabelText("Sponsor");
    fireEvent.change(inputs[inputs.length - 1] as HTMLElement, { target: { value: "Tidewater Surf Co" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    const added = (sent[0]?.body.sponsors as Array<{ id?: string; name: string }>).find((s) => s.name === "Tidewater Surf Co");
    expect(added).toBeDefined();
    expect(added).not.toHaveProperty("id");
    await screen.findByText("Saved");

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]?.body).not.toHaveProperty("sponsors");

    fireEvent.click(screen.getByRole("button", { name: "Remove Tidewater Surf Co" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(sent).toHaveLength(3));
    expect((sent[2]?.body.sponsors as Array<{ name: string }>).map((s) => s.name)).not.toContain("Tidewater Surf Co");
  });
});
