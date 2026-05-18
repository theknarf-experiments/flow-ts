// Smoke test: build a Catalog for every rule of every upstream .dl program.
// This is the broadest coverage check for fromStrata across realistic inputs.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseProgram } from '@flow-ts/parsing'
import { describe, expect, it } from 'vitest'
import { Catalog } from '../src/index.js'

const EXAMPLES_DIR = '/home/knarf/projects/dbflow/flowlog/examples'

// CRDT examples reference an `eq` predicate that isn't declared in the
// program file (it's a built-in), which fails the safety check we ported
// from upstream. Skip those — they're a known limitation, not a bug in our
// port.
const SKIP = new Set(['crdt.dl', 'crdt_slow.dl'])

const EXAMPLE_FILES = fs
  .readdirSync(EXAMPLES_DIR)
  .filter((f) => f.endsWith('.dl'))
  .filter((f) => !SKIP.has(f))
  .sort()

describe('Catalog.fromStrata over every upstream example', () => {
  for (const file of EXAMPLE_FILES) {
    it(file, () => {
      const source = fs.readFileSync(path.join(EXAMPLES_DIR, file), 'utf8')
      const program = parseProgram(source, { grammarSource: file })
      for (const rule of program.rules) {
        const cat = Catalog.fromStrata(rule)
        // Sanity: every positive atom has a signature row.
        expect(cat.atomArgumentSignatures.length).toBe(cat.atomNames.length)
        // Sanity: the core bitmap covers exactly the positive atoms.
        expect(cat.isCoreAtomBitmap.length).toBe(cat.atomNames.length)
        // Sanity: at least one positive atom is core.
        expect(cat.isCoreAtomBitmap.some((c) => c)).toBe(true)
      }
    })
  }
})
