// CLI argument parsing.
//
// Declarative pipeline: commander generates the help / `--help` output
// and does the heavy lifting of argv tokenisation; zod takes the raw
// option object and validates it (range-checks `-O`, coerces strings to
// numbers, applies defaults). The `Args` class is just the validated
// shape exposed to the rest of the CLI plus two path-derived helpers.

import * as path from 'node:path'
import { Command, Option } from 'commander'
import { z } from 'zod'

/** Zod schema for the fully-validated argument set. The CLI flags map
 *  onto these keys via the commander definition in `buildCommand` below. */
const ArgsSchema = z.object({
  program: z.string({ message: 'missing required argument: -p/--program' }),
  facts: z.string({ message: 'missing required argument: -f/--facts' }),
  csvs: z.string().nullable().default(null),
  delimiter: z.string().default(','),
  fatMode: z.boolean().default(false),
  noSharing: z.boolean().default(false),
  workers: z.coerce.number().int().positive().default(1),
  optLevel: z.coerce.number().int().min(0).max(3).nullable().default(null),
  stream: z.boolean().default(false),
})

export type ArgsInit = z.input<typeof ArgsSchema>

export class Args {
  readonly program!: string
  readonly facts!: string
  readonly csvs!: string | null
  readonly delimiter!: string
  readonly fatMode!: boolean
  readonly noSharing!: boolean
  readonly workers!: number
  readonly optLevel!: number | null
  readonly stream!: boolean

  constructor(init: ArgsInit) {
    Object.assign(this, ArgsSchema.parse(init))
  }

  /** Base name of the program file without extension. */
  programName(): string {
    const base = path.basename(this.program)
    const dot = base.lastIndexOf('.')
    return dot > 0 ? base.slice(0, dot) : base
  }

  factName(): string {
    return path.basename(this.facts)
  }
}

/** Attach the batch / stream-mode options to a Command. `program` and
 *  `facts` are intentionally NOT marked `requiredOption()` — commander
 *  enforces those across subcommands too, which breaks `flow-ts inspect`.
 *  Zod's schema parse below catches missing values and produces a
 *  descriptive error. */
export function attachBatchOptions(cmd: Command): Command {
  return cmd
    .option('-p, --program <path>', 'path of the Datalog program')
    .option('-f, --facts <dir>', 'directory containing EDB fact files')
    .option('-c, --csvs <dir>', 'directory to write IDB CSV outputs into')
    .option('-d, --delimiter <char>', 'field delimiter for fact files', ',')
    .option('--fat-mode', 'enable fat-row mode for arities > 8', false)
    // Commander's `--no-<x>` convention sets `<x>: false` when the flag
    // is passed (default true). We invert it back to `noSharing` below.
    .option('--no-sharing', 'disable transformation-output sharing across rules')
    .option('-w, --workers <n>', 'number of worker threads (informational)', '1')
    .addOption(
      new Option(
        '-O <level>',
        'optimization level: 0=as-is, 1=sip, 2=planning, 3=sip + planning',
      ).choices(['0', '1', '2', '3']),
    )
    .option(
      '--stream',
      'after loading initial EDB facts, read incremental updates from stdin (see README)',
      false,
    )
}

/** Translate commander's option object into a validated `Args` instance. */
export function argsFromOpts(opts: Record<string, unknown>): Args {
  return new Args({
    program: opts.program as string,
    facts: opts.facts as string,
    csvs: (opts.csvs as string | undefined) ?? null,
    delimiter: opts.delimiter as string,
    fatMode: opts.fatMode as boolean,
    // `--no-sharing` toggles `opts.sharing` to false (default true).
    noSharing: opts.sharing === false,
    workers: opts.workers as number,
    optLevel: (opts.O as number | undefined) ?? null,
    stream: opts.stream as boolean,
  })
}

/** Build the top-level commander program with the batch options
 *  attached at the root. Used by tests and by the binary's batch path. */
export function buildCommand(): Command {
  const cmd = new Command()
    .name('flow-ts')
    .description('A Datalog engine on top of incremental dataflow')
  return attachBatchOptions(cmd)
}

/** Parse argv (excluding node + script name) into validated `Args`. The
 *  binary entrypoint should call `buildCommand()` directly so commander
 *  can print errors / help to stderr. This helper is for tests and other
 *  programmatic callers that want a thrown error instead. */
export function parseArgs(argv: readonly string[]): Args {
  const cmd = buildCommand()
  cmd.exitOverride()
  cmd.configureOutput({ writeOut: () => {}, writeErr: () => {} })
  cmd.parse(argv as string[], { from: 'user' })
  return argsFromOpts(cmd.opts())
}
