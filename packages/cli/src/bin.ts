#!/usr/bin/env node
// Binary entrypoint for `flow-ts`. Top-level command runs the program
// (batch mode by default, streaming with --stream). The `inspect`
// subcommand prints the program / strata / plan without executing.

import { Command, Option } from 'commander'
import { ZodError } from 'zod'
import { argsFromOpts, attachBatchOptions } from './args.js'
import { runInspect } from './inspect.js'
import { readStdinLines, runCli, runStreamCli } from './main.js'

const program = new Command()
  .name('flow-ts')
  .description('A Datalog engine on top of incremental dataflow')

// Default action: run the program (batch or streaming).
attachBatchOptions(program).action(async (opts) => {
  const args = argsFromOpts(opts as Record<string, unknown>)
  if (args.stream) {
    await runStreamCli(args, readStdinLines())
  } else {
    runCli(args)
  }
})

program
  .command('inspect <program>')
  .description('Print parsed program, strata, and execution plan (no execution)')
  .option('--json', 'output as JSON instead of human-readable text', false)
  .option('--no-sharing', 'plan with transformation-output sharing disabled')
  .addOption(
    new Option(
      '-O <level>',
      'optimization level: 0=as-is, 1=sip, 2=planning, 3=sip + planning',
    ).choices(['0', '1', '2', '3']),
  )
  .action((programPath: string, opts: Record<string, unknown>) => {
    runInspect(programPath, {
      json: opts.json === true,
      noSharing: opts.sharing === false,
      optLevel: opts.O === undefined ? null : Number(opts.O),
    })
  })

try {
  await program.parseAsync(process.argv)
} catch (err) {
  if (err instanceof ZodError) {
    for (const issue of err.issues) {
      const path = issue.path.length > 0 ? ` (${issue.path.join('.')})` : ''
      console.error(`error${path}: ${issue.message}`)
    }
  } else {
    console.error((err as Error).message)
  }
  process.exit(1)
}
