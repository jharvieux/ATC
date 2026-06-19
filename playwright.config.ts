import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  globalSetup: "./tests/e2e/global-setup.ts",
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["html", { open: "never" }]],
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Auto-start the apps/main dev server. Local devs may also start it
  // manually in another terminal — reuseExistingServer respects that.
  // Skipped when an external BASE_URL is set (CI against a preview deploy).
  webServer: process.env.BASE_URL
    ? undefined
    : [
        // Tier-2.5: PostgREST + a tiny path-rewriting proxy that turns
        // `/rest/v1/<table>` (what the Supabase JS client emits) into the
        // `/{table}` shape PostgREST serves. See scripts/local-postgrest.conf,
        // scripts/local-supabase-proxy.ts, and docs/testing/e2e-local-setup.md.
        {
          command: "postgrest scripts/local-postgrest.conf",
          url: "http://127.0.0.1:54331/",
          timeout: 30_000,
          reuseExistingServer: !process.env.CI,
          stdout: "pipe",
          stderr: "pipe",
        },
        {
          command: "pnpm tsx scripts/local-supabase-proxy.ts",
          url: "http://127.0.0.1:54321/health",
          timeout: 30_000,
          reuseExistingServer: !process.env.CI,
          stdout: "pipe",
          stderr: "pipe",
        },
        {
          command: "pnpm --filter @atc/main dev",
          url: "http://localhost:3000/api/health",
          timeout: 180_000,
          reuseExistingServer: !process.env.CI,
          stdout: "pipe",
          stderr: "pipe",
        },
      ],
});
