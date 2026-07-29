import { defineConfig, devices } from '@playwright/test'

// Playwright runs against the *production preview* (`pnpm build && pnpm
// preview`) rather than the dev server.
//
// This used to be forced: Tanstack Start's dev server injected a duplicate
// `hot` declaration during HMR that the production bundle didn't have. That is
// gone with the framework, and the dev server would work fine now — but the
// preview is what users actually get, including the route chunking, and the
// build costs a few seconds. So it stays, by choice this time.

export default defineConfig({
  testDir: './e2e',
  // Each test gets a fresh page; default timeout is fine for a single
  // microtask flush in our store. Bump to 60s to cover the build step
  // before the first request lands.
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'pnpm build && pnpm preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
