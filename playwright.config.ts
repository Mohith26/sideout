import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PORT ?? 3100);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    // 390px viewport (spec §11) on Chromium so a single browser download covers both projects.
    { name: "mobile", use: { ...devices["iPhone 14"], defaultBrowserType: "chromium" } },
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    // The e2e run owns its own database so it never clobbers a developer's local seed.
    command: `npm run seed && npm run build && npm run start -- --port ${PORT}`,
    url: `${baseURL}/health`,
    timeout: 240_000,
    reuseExistingServer: !process.env.CI,
    env: {
      LUCRA_MODE: "mock",
      DATABASE_PATH: "./data/sideout.e2e.db",
      PORT: String(PORT),
      // The flows sign in as seeded users through POST /api/dev/login, which a
      // production build only contains when this is set (see next.config.ts).
      SIDEOUT_DEV_LOGIN: "true",
      // A production build never falls back to a random webhook secret, so the
      // mock's in-process deliveries (UserKYCVerified after the identity flow,
      // TournamentUserJoined after an entry) need one configured, as a real
      // deployment has. Any value works: the mock signs with the same secret.
      LUCRA_WEBHOOK_SECRET: "sideout-e2e-webhook-secret",
      // The public demo's account picker (`e2e/demo.spec.ts` signs in through it);
      // the reset token is set so the route is fully configured, but no spec
      // resets the database under the others.
      DEMO_ACCOUNTS: "true",
      DEMO_RESET_TOKEN: "sideout-e2e-demo-reset-token-0123456789",
    },
  },
});
