#!/usr/bin/env node
// Binary entrypoint for `flow-ts`. Parses argv, dispatches to `runCli`,
// and exits with status 1 on any error.

import { parseArgs } from './args.js'
import { runCli } from './main.js'

try {
  const args = parseArgs(process.argv.slice(2))
  runCli(args)
} catch (err) {
  console.error((err as Error).message)
  process.exit(1)
}
