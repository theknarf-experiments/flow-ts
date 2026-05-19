// CLI orchestration. Reads the program source + EDB CSVs from disk and
// invokes `executeProgram` from `@flow-ts/executing`. Mirrors the Rust
// `main.rs` flow.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { executeProgram, type IdbSink } from '@flow-ts/executing'
import { parseProgram } from '@flow-ts/parsing'
import type { Row } from '@flow-ts/reading'
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
  const rowMultiplicities = new Map<string, Map<string, [number[], number]>>()
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
