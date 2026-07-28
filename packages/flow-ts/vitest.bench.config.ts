import { defineConfig } from 'vitest/config'

// Benchmarks are opt-in: `pnpm -F flow-ts run bench`. They live outside the
// test suite because they trade determinism for measurement — they report
// numbers rather than asserting them, so a slow machine makes them slow, not
// red. The normal config only picks up `tests/**/*.test.ts`, so nothing here
// runs during `pnpm test`.
export default defineConfig({
  test: {
    include: ['bench/**/*.bench.ts'],
    testTimeout: 300_000,
    // One file at a time, so measurements aren't fighting each other for cores.
    fileParallelism: false,
  },
})
