import { defineConfig, devices } from '@playwright/test'

// The demo needs two processes: the Vite dev server (HTTP, health-checked
// via `webServer` below) and the WebTransport sync hub. The hub speaks
// QUIC over UDP only, so Playwright's TCP/HTTP readiness probe can't see
// it — globalSetup spawns it and waits for its "listening" log line.

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  // All tests share the single sync hub (its MST accumulates facts for
  // the lifetime of the process), so run them serially and use unique
  // card texts per test rather than asserting on board counts.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev:client --port 5173 --strictPort',
    url: 'http://localhost:5173',
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
