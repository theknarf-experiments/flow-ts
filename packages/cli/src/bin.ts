#!/usr/bin/env node
// Binary entrypoint for `flow-ts`. Parses argv via commander (so `--help`
// and validation errors land on stderr the way users expect), then hands
// off the validated `Args` to `runCli`.

import { Args, buildCommand } from './args.js'
import { runCli } from './main.js'

const cmd = buildCommand()
cmd.parse(process.argv)
const opts = cmd.opts()
try {
  const args = new Args({
    program: opts.program,
    facts: opts.facts,
    csvs: opts.csvs ?? null,
    delimiter: opts.delimiter,
    fatMode: opts.fatMode,
    noSharing: opts.sharing === false,
    workers: opts.workers,
    optLevel: opts.O ?? null,
  })
  runCli(args)
} catch (err) {
  console.error((err as Error).message)
  process.exit(1)
}
