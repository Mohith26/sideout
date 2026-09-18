import { expect, test } from "@playwright/test";

/**
 * The public demo's account picker (`DEMO_ACCOUNTS`, on for the e2e server):
 * a visitor signs in as a curated seeded user from `/sign-in`, lands where
 * that account's story starts, and every screen carries the "Demo" pill.
 * Read-only against the seeded events (no scoreline is submitted here; the
 * flows spec does that on events of its own).
 */
test.describe("demo accounts", () => {
  test("/health reports the switch", async ({ request }) => {
    const res = await request.get("/health");
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { data: { demoAccounts: boolean; devLogin: boolean } };
    expect(body.data.demoAccounts).toBe(true);
  });

  test("Captain A signs in through the picker and the match page offers the score sheet", async ({ page }) => {
    await page.goto("/sign-in");
    const picker = page.getByTestId("demo-accounts");
    await expect(picker.getByRole("heading", { name: "Demo accounts" })).toBeVisible();
    await expect(picker.getByRole("button", { name: /^Sign in as / })).toHaveCount(6);
    // The phone form is still there, untouched, below the picker.
    await expect(page.getByLabel("Phone number")).toBeVisible();
    await expect(page.getByRole("button", { name: "Text me a code" })).toBeVisible();

    const captainA = picker.getByRole("listitem").filter({ hasText: "Captain A" });
    await expect(captainA).toContainText("Awaiting scores");
    await captainA.getByRole("button", { name: /^Sign in as / }).click();

    await expect(page).toHaveURL(/\/m\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("demo-pill")).toContainText("Demo");
    // Team A's scoreline is in; the sheet is offered to revise it, the panel says who we wait on.
    await expect(page.getByTestId("submit-panel")).toContainText("Waiting on");
    await expect(page.getByRole("button", { name: "Change your scoreline" })).toBeVisible();

    // A demo session is a normal session: the profile loads, and it is audited server-side (route tests).
    const me = await page.request.get("/api/me");
    expect(me.ok()).toBe(true);
  });

  test("the organizer lands in the console and Captain B is offered the answering sheet", async ({ page, browser }) => {
    await page.goto("/sign-in");
    const picker = page.getByTestId("demo-accounts");
    await picker.getByRole("listitem").filter({ hasText: "Organizer" }).getByRole("button", { name: /^Sign in as / }).click();
    await expect(page).toHaveURL(/\/organizer\/events$/);
    await expect(page.getByTestId("demo-pill")).toBeVisible();

    const other = await (await browser.newContext()).newPage();
    await other.goto("/sign-in");
    await other.getByTestId("demo-accounts").getByRole("listitem").filter({ hasText: "Captain B" }).getByRole("button", { name: /^Sign in as / }).click();
    await expect(other).toHaveURL(/\/m\/[0-9a-f-]{36}$/);
    await expect(other.getByTestId("submit-panel")).toContainText("has submitted");
    await expect(other.getByRole("button", { name: "Confirm the result" })).toBeVisible();
  });

  test("a deep link is honoured after a demo sign-in, and sign-out drops the pill", async ({ page }) => {
    await page.goto("/sign-in?next=%2Fevents");
    await page.getByTestId("demo-accounts").getByRole("listitem").filter({ hasText: "Registering captain" }).getByRole("button", { name: /^Sign in as / }).click();
    await expect(page).toHaveURL(/\/events$/);
    await expect(page.getByTestId("demo-pill")).toBeVisible();
    await page.request.post("/api/auth/logout");
    await page.goto("/events");
    await expect(page.getByTestId("demo-pill")).toHaveCount(0);
  });
});
