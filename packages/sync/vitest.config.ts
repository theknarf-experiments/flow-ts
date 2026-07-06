import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    // Session pumps use real setInterval; if two heavy test files
    // run concurrently the event loop gets contended and the
    // pump's timers fire late — retry budgets exhaust before their
    // wall-clock target. Serialise files (tests within a file
    // still run in one process) so time-sensitive property tests
    // hit their expected timings.
    fileParallelism: false,
    poolOptions: {
      threads: { singleThread: true },
      forks: { singleFork: true },
    },
  },
})
