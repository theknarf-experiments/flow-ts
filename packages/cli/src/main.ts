// CLI orchestration. Reads the program source + EDB CSVs from disk and
// invokes `executeProgram` / `openSession` from `@flow-ts/executing`.
// Mirrors the Rust `main.rs` flow.

import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  executeProgram,
  openSession,
  type IdbSink,
  type ProgramSession,
} from 'flow-ts'
import { parseProgram } from '@flow-ts/parsing'
import type { Row } from 'flow-ts'
import type { Args } from './args.js'
import {
  appendCsvRow,
  appendSizeLine,
  closeAllFiles,
  readRowsForRelDecl,
} from './io.js'

/**
 * End-to-end CLI run: read program, load EDBs, execute, emit IDB rows to
 * stdout (and CSVs under `args.csvs` when set). Returns the per-relation
 * row counts so callers / tests can inspect outcomes without scraping stdout.
 */
export function runCli(args: Args): Map<string, number> {
  const source = fs.readFileSync(args.program, 'utf8')
  const program = parseProgram(source, { grammarSource: args.program })

  const edbFacts = new Map<string, readonly Row[]>()
  for (const edb of program.edbs) {
    edbFacts.set(edb.name, readRowsForRelDecl(edb, args.facts, args.delimiter))
  }

  // Accumulate per-row multiplicities. db-ivm emits intermediate diffs
  // during fixpoint iteration — same row can be +1 / -1 across ticks —
  // so we collapse to the final set after `executeProgram` returns.
  const rowMultiplicities = new Map<string, Map<string, [Row, number]>>()
  const sink: IdbSink = (rel, row, diff) => {
    let rels = rowMultiplicities.get(rel)
    if (!rels) {
      rels = new Map()
      rowMultiplicities.set(rel, rels)
    }
    const key = row.map((v) => v.toString()).join(',')
    const entry = rels.get(key)
    if (entry) {
      entry[1] += diff
    } else {
      rels.set(key, [[...row], diff])
    }
  }

  try {
    executeProgram(
      program,
      edbFacts,
      { noSharing: args.noSharing, optLevel: args.optLevel },
      sink,
    )

    const counts = new Map<string, number>()
    for (const [rel, rels] of rowMultiplicities) {
      for (const [, [row, net]] of rels) {
        if (net <= 0) continue
        counts.set(rel, (counts.get(rel) ?? 0) + 1)
        const line = row.map((v) => v.toString()).join(',')
        if (args.csvs !== null) {
          appendCsvRow(path.join(args.csvs, 'csvs', `${rel}.csv`), row)
        } else {
          console.log(`${rel}: ${line}`)
        }
      }
    }

    if (args.csvs !== null) {
      const sizePath = path.join(args.csvs, 'csvs', 'size.txt')
      for (const [rel, count] of counts) {
        appendSizeLine(sizePath, rel, count)
      }
    }
    return counts
  } finally {
    closeAllFiles()
  }
}

// --------------------------------------------------------------------------
// Streaming mode
// --------------------------------------------------------------------------

/** A single line of streaming input. The format mirrors the upstream
 *  `crossbeam_channel` shape from the Rust streaming runner, lightly
 *  reshaped for a line-oriented stdin protocol:
 *    `+ <Rel> <c1>,<c2>,...`   insert
 *    `- <Rel> <c1>,<c2>,...`   retract
 *    blank line / `.advance`   drive the graph to a fixpoint
 *    `.quit`                   stop reading (also: EOF)
 *    lines starting with `#` are comments and ignored
 */
type Update =
  | { kind: 'update'; rel: string; row: Row; diff: number }
  | { kind: 'advance' }
  | { kind: 'quit' }
  | { kind: 'skip' }

function parseStreamLine(line: string): Update {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed === '.advance') return { kind: 'advance' }
  if (trimmed === '.quit') return { kind: 'quit' }
  if (trimmed.startsWith('#')) return { kind: 'skip' }
  const sign = trimmed[0]
  if (sign !== '+' && sign !== '-') {
    throw new Error(`stream: unrecognised directive "${trimmed}"`)
  }
  const rest = trimmed.slice(1).trim()
  const spaceIdx = rest.indexOf(' ')
  if (spaceIdx < 0) {
    throw new Error(`stream: missing row after relation in "${trimmed}"`)
  }
  const rel = rest.slice(0, spaceIdx)
  const cols = rest.slice(spaceIdx + 1).trim()
  const row = cols.length === 0 ? [] : cols.split(',').map((s) => Number(s.trim()))
  if (row.some((v) => Number.isNaN(v))) {
    throw new Error(`stream: non-numeric column in "${trimmed}"`)
  }
  return { kind: 'update', rel, row, diff: sign === '+' ? 1 : -1 }
}

/**
 * Streaming CLI run: load initial EDB facts, then read incremental
 * updates from `input` line-by-line. Each tick (blank line / `.advance`)
 * drives the graph to a fixpoint and emits the IDB diffs from that tick
 * to `output`.
 *
 * Output format: `<sign><N>\t<Rel>\t<c1>,<c2>,...` per IDB diff, where
 * `<sign><N>` is `+1`, `-1`, etc. Diffs that net to zero within a tick
 * are collapsed so consumers see only the net change.
 */
export function runStreamCli(
  args: Args,
  input: AsyncIterable<string> | Iterable<string>,
  output: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
): Promise<void> {
  const source = fs.readFileSync(args.program, 'utf8')
  const program = parseProgram(source, { grammarSource: args.program })

  // Per-tick diff buffer; flushed on each advance.
  type Pending = Map<string, Map<string, [Row, number]>>
  let pending: Pending = new Map()
  const recordDiff = (rel: string, row: Row, diff: number) => {
    let rels = pending.get(rel)
    if (!rels) {
      rels = new Map()
      pending.set(rel, rels)
    }
    const key = row.map((v) => v.toString()).join(',')
    const entry = rels.get(key)
    if (entry) entry[1] += diff
    else rels.set(key, [[...row], diff])
  }
  const sink: IdbSink = (rel, row, diff) => recordDiff(rel, row, diff)

  const session: ProgramSession = openSession(
    program,
    { noSharing: args.noSharing, optLevel: args.optLevel },
    sink,
  )

  // Seed: initial EDB facts from disk.
  for (const edb of program.edbs) {
    const rows = readRowsForRelDecl(edb, args.facts, args.delimiter)
    for (const row of rows) session.update(edb.name, row, 1)
  }
  // Drive the initial advance so the user gets the baseline state.
  flushTick()

  function flushTick(): void {
    session.advance()
    for (const [rel, rels] of pending) {
      for (const [, [row, net]] of rels) {
        if (net === 0) continue
        const sign = net > 0 ? `+${net}` : `${net}`
        output(`${sign}\t${rel}\t${row.map((v) => v.toString()).join(',')}`)
      }
    }
    pending = new Map()
  }

  async function loop(): Promise<void> {
    try {
      for await (const line of input as AsyncIterable<string>) {
        let directive: Update
        try {
          directive = parseStreamLine(line)
        } catch (e) {
          output(`!\t${(e as Error).message}`)
          continue
        }
        if (directive.kind === 'skip') continue
        if (directive.kind === 'quit') break
        if (directive.kind === 'advance') {
          flushTick()
          continue
        }
        try {
          session.update(directive.rel, directive.row, directive.diff)
        } catch (e) {
          output(`!\t${(e as Error).message}`)
        }
      }
      // Final flush on EOF (covers callers that don't send `.advance`).
      flushTick()
    } finally {
      try { session.close() } catch { /* already-closed is fine */ }
    }
  }
  return loop()
}

/** Yield stdin lines one at a time. Splits on `\n`, preserves blank
 *  lines (they're meaningful — they trigger an advance). */
export async function* readStdinLines(): AsyncIterable<string> {
  let buf = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    buf += chunk as string
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      yield buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      nl = buf.indexOf('\n')
    }
  }
  if (buf.length > 0) yield buf
}
