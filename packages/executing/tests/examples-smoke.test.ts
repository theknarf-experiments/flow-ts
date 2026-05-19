// Smoke test: try running every upstream .dl program with synthetic EDB
// facts. The goal is *coverage*, not correctness — we want to surface
// every transformation kind / flow shape that the executor doesn't yet
// handle. Failures here are tagged as "TODO" / not assertions.
//
// Tests don't fail; they record passes & failures and print a summary.

import * as fs from 'node:fs'
import { parseProgram } from '@flow-ts/parsing'
import type { Row } from '@flow-ts/reading'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { executeProgram } from '../src/index.js'

const EXAMPLES_DIR = '/home/knarf/projects/dbflow/flowlog/examples'

// crdt* uses undeclared eq built-in; sssp wants the nemo_arithmetic branch.
const SKIP = new Set(['crdt.dl', 'crdt_slow.dl', 'sssp.dl'])

beforeEach(() => {})
afterEach(() => {})

/** Produce a moderate-sized synthetic dataset (50 rows per EDB, values mod 16)
 *  for each EDB the program declares. Matches the oracle's defaults. */
function generateFacts(program: ReturnType<typeof parseProgram>): Map<string, Row[]> {
  const N = 50
  const MOD = 16
  const out = new Map<string, Row[]>()
  for (const edb of program.edbs) {
    if (!edb.path) continue
    const arity = edb.arity()
    const rows: Row[] = []
    for (let i = 0; i < N; i++) {
      const row: number[] = []
      for (let c = 0; c < arity; c++) {
        row.push(Number((i + c) % MOD))
      }
      rows.push(row)
    }
    out.set(edb.name, rows)
  }
  return out
}

interface Outcome {
  file: string
  ok: boolean
  error?: string
  idbRowCount?: number
}

const outcomes: Outcome[] = []

describe('executeProgram smoke coverage', () => {
  const files = fs
    .readdirSync(EXAMPLES_DIR)
    .filter((f) => f.endsWith('.dl'))
    .filter((f) => !SKIP.has(f))
    .sort()

  for (const file of files) {
    it(file, () => {
      const programPath = `${EXAMPLES_DIR}/${file}`
      const source = fs.readFileSync(programPath, 'utf8')
      let program: ReturnType<typeof parseProgram>
      let facts: Map<string, Row[]>
      try {
        program = parseProgram(source, { grammarSource: programPath })
        facts = generateFacts(program)
      } catch (e) {
        outcomes.push({ file, ok: false, error: `setup: ${(e as Error).message}` })
        return
      }

      let rowCount = 0
      try {
        executeProgram(program, facts, {}, (_rel, _row, _diff) => {
          rowCount++
        })
        outcomes.push({ file, ok: true, idbRowCount: rowCount })
        expect(true).toBe(true)
      } catch (e) {
        const msg = (e as Error).message.split('\n')[0]!.slice(0, 120)
        outcomes.push({ file, ok: false, error: msg })
        // Don't fail the test; the goal is to map the gap, not block.
        expect(true).toBe(true)
      }
    })
  }

  it('summary', () => {
    const passed = outcomes.filter((o) => o.ok)
    const failed = outcomes.filter((o) => !o.ok)
    console.log(
      `\n=== executing smoke coverage: ${passed.length} / ${outcomes.length} passed ===`,
    )
    if (passed.length > 0) {
      console.log('\nPASSED:')
      for (const o of passed) {
        console.log(`  ✓ ${o.file}  (${o.idbRowCount} rows)`)
      }
    }
    if (failed.length > 0) {
      console.log('\nFAILED:')
      for (const o of failed) {
        console.log(`  × ${o.file}  ${o.error ?? ''}`)
      }
    }
    expect(true).toBe(true)
  })
})
