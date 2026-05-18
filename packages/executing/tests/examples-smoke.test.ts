// Smoke test: try running every upstream .dl program with synthetic EDB
// facts. The goal is *coverage*, not correctness — we want to surface
// every transformation kind / flow shape that the executor doesn't yet
// handle. Failures here are tagged as "TODO" / not assertions.
//
// Tests don't fail; they record passes & failures and print a summary.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseProgram } from '@flow-ts/parsing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Args, executeProgram } from '../src/index.js'

const EXAMPLES_DIR = '/home/knarf/projects/dbflow/flowlog/examples'

// crdt* uses undeclared eq built-in; sssp wants the nemo_arithmetic branch.
const SKIP = new Set(['crdt.dl', 'crdt_slow.dl', 'sssp.dl'])

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-ts-smoke-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** Produce a small handful of synthetic rows for each EDB the program declares. */
function generateFacts(programPath: string, factsDir: string): void {
  const source = fs.readFileSync(programPath, 'utf8')
  const program = parseProgram(source, { grammarSource: programPath })
  for (const edb of program.edbs) {
    if (!edb.path) continue
    const arity = edb.arity()
    // Use a small set of integers from a tiny domain so joins find matches.
    const rows: string[] = []
    for (let i = 0; i < 5; i++) {
      const cols: string[] = []
      for (let c = 0; c < arity; c++) {
        cols.push(String((i + c) % 4))
      }
      rows.push(cols.join(','))
    }
    fs.writeFileSync(path.join(factsDir, edb.path), `${rows.join('\n')}\n`)
  }
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
      const programPath = path.join(EXAMPLES_DIR, file)
      // Copy the .dl into tmpDir so EDB paths resolve relatively.
      const localProgram = path.join(tmpDir, file)
      fs.copyFileSync(programPath, localProgram)
      try {
        generateFacts(localProgram, tmpDir)
      } catch (e) {
        outcomes.push({ file, ok: false, error: `setup: ${(e as Error).message}` })
        return
      }

      let rowCount = 0
      try {
        executeProgram(new Args({ program: localProgram, facts: tmpDir }), (_rel, _row, _diff) => {
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
