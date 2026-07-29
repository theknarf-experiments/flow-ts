import { defineConfig, devices } from '@playwright/test'

// Playwright runs against the *production preview* (`pnpm build && pnpm
// preview`). Tanstack Start's dev server has an unresolved code-splitter
// interaction that injects a duplicate `hot` declaration during HMR;
// the production bundle is unaffected. Testing the preview also matches
// what users actually deploy. Build time is a few seconds.

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
