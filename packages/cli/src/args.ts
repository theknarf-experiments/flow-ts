// Port of flowlog/src/executing/src/arg.rs
//
// Args mirrors the Rust clap CLI. The TS executor is single-threaded by
// default (d2ts doesn't natively multi-thread the way DD does), so `workers`
// is informational. `optLevel` matches the Rust meaning:
//   null → as-is, 1 → sip, 2 → planning, 3 → sip + planning.

import * as path from 'node:path'

export interface ArgsInit {
  program: string
  facts: string
  csvs?: string | null
  delimiter?: string
  fatMode?: boolean
  noSharing?: boolean
  workers?: number
  optLevel?: number | null
}

export class Args {
  readonly program: string
  readonly facts: string
  readonly csvs: string | null
  readonly delimiter: string
  readonly fatMode: boolean
  readonly noSharing: boolean
  readonly workers: number
  readonly optLevel: number | null

  constructor(init: ArgsInit) {
    this.program = init.program
    this.facts = init.facts
    this.csvs = init.csvs ?? null
    this.delimiter = init.delimiter ?? ','
    this.fatMode = init.fatMode ?? false
    this.noSharing = init.noSharing ?? false
    this.workers = init.workers ?? 1
    this.optLevel = init.optLevel ?? null
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

/** Parse argv (excluding node + script name) into Args. */
export function parseArgs(argv: readonly string[]): Args {
  let program: string | undefined
  let facts: string | undefined
  let csvs: string | null = null
  let delimiter = ','
  let fatMode = false
  let noSharing = false
  let workers = 1
  let optLevel: number | null = null

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`missing value for ${arg}`)
      return v
    }
    switch (arg) {
      case '-p':
      case '--program':
        program = next()
        break
      case '-f':
      case '--facts':
        facts = next()
        break
      case '-c':
      case '--csvs':
        csvs = next()
        break
      case '-d':
      case '--delimiter':
        delimiter = next()
        break
      case '--fat-mode':
        fatMode = true
        break
      case '--no-sharing':
        noSharing = true
        break
      case '-w':
      case '--workers':
        workers = Number.parseInt(next(), 10)
        break
      case '-O': {
        const v = Number.parseInt(next(), 10)
        if (Number.isNaN(v) || v < 0 || v > 3) {
          throw new Error(`-O must be in 0..=3, got ${argv[i]}`)
        }
        optLevel = v
        break
      }
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (!program) throw new Error('missing required argument: -p/--program')
  if (!facts) throw new Error('missing required argument: -f/--facts')
  return new Args({
    program,
    facts,
    csvs,
    delimiter,
    fatMode,
    noSharing,
    workers,
    optLevel,
  })
}
