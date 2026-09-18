import { expect, test } from "@playwright/test";

/**
 * Smoke over the Lucra surfaces against the production build in mock mode:
 * `/admin/lucra` lists the seeded attempt rows with their exact JSON, the
 * audit route filters, the mock's state route exists in a mock build and is
 * organizer-gated, and `/health` reports the pin and the matcher reading.
 * Read-only: nothing here writes to Lucra.
 */
const ORGANIZER_PHONE = "+15550109000";

test.describe("Lucra audit surfaces", () => {
  test("/health reports the pinned SDK version and the matcher interpretation", async ({ request }) => {
    const res = await request.get("/health");
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { data: { lucraMode: string; lucraSdkVersion: string; lucraSdk: { package: string; source: string }; lucraMatcherInterpretation: string } };
    expect(body.data.lucraMode).toBe("mock");
    expect(body.data.lucraSdkVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.data.lucraSdk).toMatchObject({ package: "lucra-web-sdk", source: expect.stringContaining("github:Lucra-Sports/lucra-web-sdk#v") });
    expect(body.data.lucraMatcherInterpretation).toBe("literal");
  });

  test("/admin/lucra shows every seeded attempt with the exact request and response, every outcome, and the targeting state", async ({ page }) => {
    expect((await page.request.post("/api/dev/login", { data: { phone: ORGANIZER_PHONE } })).ok()).toBe(true);
    await page.goto("/admin/lucra");
    await expect(page.getByRole("heading", { level: 1, name: "Lucra writes" })).toBeVisible();
    await expect(page.getByTestId("lucra-health")).toContainText("mock");
    // Three seeded events (another spec may add a draft to the shared database).
    expect(await page.getByTestId("lucra-tournament").count()).toBeGreaterThanOrEqual(3);
    const rows = page.getByTestId("lucra-submission");
    expect(await rows.count()).toBeGreaterThan(50);
    for (const label of ["Accepted", "Partial", "Rejected", "Transport error"]) {
      await expect(rows.filter({ hasText: label }).first()).toBeVisible();
    }
    // Open a rejected attempt: the documented body is there verbatim, the key is not.
    const rejected = rows.filter({ hasText: "Rejected" }).first();
    await rejected.locator("summary").click();
    await expect(rejected).toContainText('"error": "Matchup not found"');
    await expect(rejected).toContainText('"X-Lucra-Api-Key": "[redacted]"');
    await expect(rejected).toContainText("/api/rest/pool-tournament/user-score");
    await expect(rejected).not.toContainText("sideout-mock-backend-key");

    // The outcome filter narrows the list.
    await page.goto("/admin/lucra?outcome=partial");
    await expect(page.getByTestId("lucra-submission")).toHaveCount(1);
    await expect(page.getByTestId("lucra-submission")).toContainText("Partial");
  });

  test("the audit route and the mock state route are organizer-gated; the mock holds the overlapping matchups", async ({ page, request }) => {
    expect((await request.get("/api/admin/lucra/submissions")).status()).toBe(401);
    expect((await request.get("/api/rest/_mock/state")).status()).toBe(401);
    expect((await page.request.post("/api/dev/login", { data: { phone: ORGANIZER_PHONE } })).ok()).toBe(true);
    const audit = await page.request.get("/api/admin/lucra/submissions?outcome=rejected");
    expect(audit.ok()).toBe(true);
    const body = (await audit.json()) as { data: { submissions: Array<{ row: { outcome: string; httpStatus: number | null } }> } };
    expect(body.data.submissions).toHaveLength(1);
    expect(body.data.submissions[0]?.row).toMatchObject({ outcome: "rejected", httpStatus: 404 });

    const state = await page.request.get("/api/rest/_mock/state");
    expect(state.ok()).toBe(true);
    const mock = (await state.json()) as { data: { matchups: Array<{ kind: string; metadata: { season?: string; externalId?: string } }> } };
    expect(mock.data.matchups.filter((m) => m.metadata.season === "2026-spring")).toHaveLength(3);
    expect(mock.data.matchups.filter((m) => m.kind === "recreational")).toHaveLength(2);
    expect(JSON.stringify(mock)).not.toContain("LUCRA_BACKEND");
  });
});
