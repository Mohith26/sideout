import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGlobalImpact } from "@/db/queries/impact";
import { tournaments } from "@/db/schema";
import { sweepDueDonations } from "@/server/donations/stub-provider";
import { SLUGS } from "@/seed/build";
import { createTestApp, type TestApp } from "@/test/routes";

describe("getGlobalImpact", () => {
  let app: TestApp;
  beforeEach(() => {
    app = createTestApp();
  });
  afterEach(() => app.close());

  it("counts a stub intent once its delay has run and the page has swept, then stays put", () => {
    const succeeded = app.data.donations.filter((d) => d.status === "succeeded");
    const pending = app.data.donations.filter((d) => d.status === "pending");
    expect(pending.length).toBeGreaterThan(0);
    expect(getGlobalImpact().totalRaisedCents).toBe(succeeded.reduce((s, d) => s + d.amountCents, 0));
    expect(sweepDueDonations(Date.now())).toBe(pending.length);
    const swept = getGlobalImpact();
    expect(swept.totalRaisedCents).toBe([...succeeded, ...pending].reduce((s, d) => s + d.amountCents, 0));
    expect(swept.donorCount).toBe(succeeded.length + pending.length);
    expect(sweepDueDonations(Date.now())).toBe(0);
    expect(getGlobalImpact()).toEqual(swept);
  });

  it("sums succeeded donations and goals over published events only", () => {
    const before = getGlobalImpact();
    expect(before.perEvent.map((e) => e.tournament.slug).sort()).toEqual([SLUGS.live, SLUGS.settled, SLUGS.upcoming].sort());
    const succeeded = app.data.donations.filter((d) => d.status === "succeeded");
    expect(before.totalRaisedCents).toBe(succeeded.reduce((s, d) => s + d.amountCents, 0));
    expect(before.donorCount).toBe(succeeded.length);
    expect(before.totalGoalCents).toBe(app.data.tournaments.reduce((s, t) => s + t.fundraisingGoalCents, 0));

    // An organizer's draft carries a goal and may already hold rows, but it is not public yet.
    app.conn.db
      .insert(tournaments)
      .values({ ...app.tournament(SLUGS.upcoming), id: "draft-1", slug: "secret-2027", name: "Secret Invitational", status: "draft", fundraisingGoalCents: 100000, lucraExternalId: "sideout-draft-1", createdAt: app.anchorMs })
      .run();
    const withDraft = getGlobalImpact();
    expect(withDraft.perEvent.map((e) => e.tournament.slug)).not.toContain("secret-2027");
    expect(withDraft.totalGoalCents).toBe(before.totalGoalCents);
    expect(withDraft.totalRaisedCents).toBe(before.totalRaisedCents);

    // Publishing it is what puts it on the board.
    app.conn.db.update(tournaments).set({ status: "registration_open" }).where(eq(tournaments.id, "draft-1")).run();
    const published = getGlobalImpact();
    expect(published.perEvent.map((e) => e.tournament.slug)).toContain("secret-2027");
    expect(published.totalGoalCents).toBe(before.totalGoalCents + 100000);
    expect(published.perEvent.find((e) => e.tournament.slug === "secret-2027")).toMatchObject({ raisedCents: 0, donorCount: 0 });
  });
});
