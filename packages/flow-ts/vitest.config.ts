import { defineConfig } from 'vitest/config'

// Consolidated config for the merged executing/optimizing/planning/
// reading/strata/catalog modules. 30s timeout covers the executing
// and planning suites; the others finish in tens of ms.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
  },
})
