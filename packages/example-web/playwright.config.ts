import { defineConfig, devices } from '@playwright/test'

// Playwright config for the example-web e2e suite. We boot Vite's dev
// server (with HMR / source maps) so failures point at TS sources, but
// the production build works the same way — if you want to test the
// shipped bundle, change `webServer.command` to `pnpm preview`.

export default defineConfig({
  testDir: './e2e',
  // Each test gets a fresh page; default timeout is fine for a single
  // microtask flush in our store.
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
