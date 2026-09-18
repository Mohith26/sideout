import { expect, test } from "@playwright/test";

/**
 * Smoke: the seeded app boots and Home renders the three seeded events in
 * their three states. The two real end-to-end flows (player and organizer)
 * are phase 5.
 */
test.describe("Home", () => {
  test("renders seeded events from the database", async ({ page }) => {
    await page.goto("/");

    // Live strip for the in-progress event.
    await expect(page.getByRole("heading", { name: /Live · Sandbar Classic/ })).toBeVisible();
    await expect(page.getByText("Set 2 in play")).toBeVisible();
    await expect(page.getByText("Scorelines differ")).toBeVisible();

    // Featured (live), upcoming, and past events.
    await expect(page.getByRole("heading", { name: "Sandbar Classic", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Pier 9 Open", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Low Tide Open", exact: true })).toBeVisible();

    // Impact figures are derived: the featured meter shows a percentage of a goal.
    const meter = page.getByRole("progressbar", { name: "Fundraising progress" }).first();
    await expect(meter).toBeVisible();
    const now = Number(await meter.getAttribute("aria-valuenow"));
    const max = Number(await meter.getAttribute("aria-valuemax"));
    expect(now).toBeGreaterThan(0);
    expect(now).toBeLessThan(max);
  });

  test("navigates to the live event and shows the bracket state honestly", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Sandbar Classic", exact: true }).first().click();
    await expect(page).toHaveURL(/\/t\/sandbar-classic-2026$/);
    await expect(page.getByRole("heading", { level: 1, name: "Sandbar Classic" })).toBeVisible();
    await expect(page.getByText("Disputed").first()).toBeVisible();
    await expect(page.getByText("Bye").first()).toBeVisible();

    await page.getByRole("link", { name: "Bracket" }).click();
    await expect(page.getByRole("list", { name: /rounds$/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /advances on a bye/ })).toBeAttached();
  });

  test("/health reports the mock mode and applied migrations", async ({ request }) => {
    const res = await request.get("/health");
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { ok: boolean; data: { lucraMode: string; migrations: { pending: number } } };
    expect(body.ok).toBe(true);
    expect(body.data.lucraMode).toBe("mock");
    expect(body.data.migrations.pending).toBe(0);
  });
});
