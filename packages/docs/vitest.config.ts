import { defineConfig } from 'vitest/config'

// The unit suite here is about the *lessons*, not about the app: it runs every
// tutorial program against its seed facts and checks the rows the prose claims.
// The browser-level suite is Playwright's, and lives in `e2e/` — hence the
// exclude, so `vitest run` doesn't try to execute Playwright specs.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
