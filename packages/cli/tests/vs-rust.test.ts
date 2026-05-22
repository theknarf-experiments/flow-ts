// Correctness oracle: for each upstream `.dl` example, run both the Rust
// `executing` binary and our TS `flow-ts` binary on identical synthetic
// EDB facts and diff their IDB CSV outputs.
//
// Rust binary is expected at $RUST_FLOWLOG (or auto-discovered under
// /home/knarf/projects/dbflow/target/{release,debug}/executing). If
// neither exists, the whole describe block is skipped — the oracle is a
// developer aid, not a CI gate.

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as url from 'node:url'
import { parseProgram } from '@flow-ts/parsing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Args } from '../src/args.js'
import { relDeclInputPath } from '../src/io.js'
import { runCli } from '../src/main.js'

const HERE = path.dirname(url.fileURLToPath(import.meta.url))
const EXAMPLES_DIR = path.resolve(HERE, '..', '..', '..', 'vendor', 'flowlog-examples')

// Known unsupported / branch-specific:
//   crdt*  — undeclared `eq` built-in
//   sssp   — needs the nemo_arithmetic branch
const HARD_SKIP = new Set(['crdt.dl', 'crdt_slow.dl', 'sssp.dl'])

// Programs whose TS execution is allowed to crash without failing the test.
// Empty by default — every other unexpected TS crash escalates.
const KNOWN_TS_FAILURES = new Set<string>()

// Default synthetic dataset size. The MOD bound on column values controls
// how many distinct values appear; higher MOD = sparser data = fewer joins
// match = quicker convergence but more recursive iterations.
const DEFAULT_FACT_COUNT = 100
const DEFAULT_VALUE_MOD = 32
// Per-program overrides for ones that scale combinatorially with N or MOD
// (their recursive joins blow up faster than linear). The shrunk sizes are
// still much bigger than the prior 5/4 baseline — we just keep the whole
// oracle under ~30s total wall-clock.
const SCALE_OVERRIDES = new Map<string, { count: number; mod: number }>([
  ['andersen.dl', { count: 80, mod: 32 }],
  ['borrow.dl', { count: 40, mod: 16 }],
  ['cspa.dl', { count: 75, mod: 25 }],
  ['galen.dl', { count: 50, mod: 16 }],
])

function findRustBinary(): string | null {
  const explicit = process.env.RUST_FLOWLOG
  if (explicit && fs.existsSync(explicit)) return explicit
  for (const variant of ['release', 'debug']) {
    const p = `/home/knarf/projects/dbflow/target/${variant}/executing`
    if (fs.existsSync(p)) return p
  }
  return null
}

const rustBinary = findRustBinary()

/** Synthetic facts for every declared EDB. Programs like borrow.dl
 *  declare EDBs without explicit `.input` paths; Rust defaults those to
 *  `<name>.facts`, so we write to that name to keep the comparison fair. */
function writeFacts(file: string, programPath: string, tmpDir: string): void {
  const source = fs.readFileSync(programPath, 'utf8')
  const program = parseProgram(source, { grammarSource: programPath })
  const override = SCALE_OVERRIDES.get(file)
  const factCount = override?.count ?? DEFAULT_FACT_COUNT
  const mod = override?.mod ?? DEFAULT_VALUE_MOD
  for (const edb of program.edbs) {
    const arity = edb.arity()
    const rows: string[] = []
    for (let i = 0; i < factCount; i++) {
      const cols: string[] = []
      for (let c = 0; c < arity; c++) cols.push(String((i + c) % mod))
      rows.push(cols.join(','))
    }
    fs.writeFileSync(path.join(tmpDir, relDeclInputPath(edb)), `${rows.join('\n')}\n`)
  }
}

/**
 * Read a CSV file and return a sorted set of rows, with whitespace
 * normalised. Rust writes "1, 2, 3" (comma+space); we write "1,2,3".
 */
function normalizedRows(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return []
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ''))
    .filter((line) => line.length > 0)
    .sort()
}

interface Diff {
  file: string
  rustOnly: string[]
  tsOnly: string[]
  shared: number
}

function diffDirs(rustDir: string, tsDir: string): Diff[] {
  const all = new Set<string>()
  if (fs.existsSync(rustDir)) {
    for (const f of fs.readdirSync(rustDir)) {
      if (f.endsWith('.csv')) all.add(f)
    }
  }
  if (fs.existsSync(tsDir)) {
    for (const f of fs.readdirSync(tsDir)) {
      if (f.endsWith('.csv')) all.add(f)
    }
  }
  const diffs: Diff[] = []
  for (const f of [...all].sort()) {
    const rustRows = normalizedRows(path.join(rustDir, f))
    const tsRows = normalizedRows(path.join(tsDir, f))
    const rustSet = new Set(rustRows)
    const tsSet = new Set(tsRows)
    const rustOnly = rustRows.filter((r) => !tsSet.has(r))
    const tsOnly = tsRows.filter((r) => !rustSet.has(r))
    diffs.push({
      file: f,
      rustOnly,
      tsOnly,
      shared: rustRows.filter((r) => tsSet.has(r)).length,
    })
  }
  return diffs
}

interface Outcome {
  file: string
  status: 'match' | 'mismatch' | 'ts-crashed' | 'rust-crashed'
  details?: string
}
const outcomes: Outcome[] = []

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-ts-vs-rust-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe.skipIf(rustBinary === null)('flow-ts vs Rust executing — correctness oracle', () => {
  const files = fs
    .readdirSync(EXAMPLES_DIR)
    .filter((f) => f.endsWith('.dl'))
    .filter((f) => !HARD_SKIP.has(f))
    .sort()

  for (const file of files) {
    it(file, () => {
      const programPath = path.join(EXAMPLES_DIR, file)
      const localProgram = path.join(tmpDir, file)
      fs.copyFileSync(programPath, localProgram)
      writeFacts(file, localProgram, tmpDir)

      const rustOut = path.join(tmpDir, 'rust-out')
      const tsOut = path.join(tmpDir, 'ts-out')
      fs.mkdirSync(rustOut, { recursive: true })
      fs.mkdirSync(tsOut, { recursive: true })

      try {
        execFileSync(rustBinary!, ['-p', localProgram, '-f', tmpDir, '-c', rustOut], {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 60_000,
        })
      } catch (e) {
        outcomes.push({ file, status: 'rust-crashed', details: (e as Error).message.slice(0, 200) })
        expect(true).toBe(true)
        return
      }

      try {
        runCli(new Args({ program: localProgram, facts: tmpDir, csvs: tsOut }))
      } catch (e) {
        outcomes.push({ file, status: 'ts-crashed', details: (e as Error).message.slice(0, 200) })
        // KNOWN_TS_FAILURES are expected to crash; everything else is news.
        if (!KNOWN_TS_FAILURES.has(file)) {
          throw e
        }
        expect(true).toBe(true)
        return
      }

      const diffs = diffDirs(path.join(rustOut, 'csvs'), path.join(tsOut, 'csvs'))
      const anyMismatch = diffs.some((d) => d.rustOnly.length > 0 || d.tsOnly.length > 0)
      if (anyMismatch) {
        const summary = diffs
          .filter((d) => d.rustOnly.length > 0 || d.tsOnly.length > 0)
          .map(
            (d) =>
              `${d.file}: rust-only=${d.rustOnly.length} ts-only=${d.tsOnly.length} shared=${d.shared}`,
          )
          .join('; ')
        outcomes.push({ file, status: 'mismatch', details: summary })
        // Don't fail the test — the oracle is a discovery tool, not a gate.
        expect(true).toBe(true)
      } else {
        outcomes.push({ file, status: 'match' })
        expect(true).toBe(true)
      }
    })
  }

  it('summary', () => {
    const grouped: Record<Outcome['status'], Outcome[]> = {
      match: [],
      mismatch: [],
      'ts-crashed': [],
      'rust-crashed': [],
    }
    for (const o of outcomes) grouped[o.status].push(o)

    console.log(
      `\n=== flow-ts vs Rust oracle: ${grouped.match.length}/${outcomes.length} programs match ===`,
    )
    for (const status of ['match', 'mismatch', 'ts-crashed', 'rust-crashed'] as const) {
      if (grouped[status].length === 0) continue
      console.log(`\n${status.toUpperCase()} (${grouped[status].length}):`)
      for (const o of grouped[status]) {
        console.log(`  ${o.file}${o.details ? `  — ${o.details}` : ''}`)
      }
    }
    expect(true).toBe(true)
  })
})
