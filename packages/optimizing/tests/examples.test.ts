// Smoke test: build a PlanTree (default and optimized) for every rule of
// every upstream .dl program — same coverage style as the catalog suite.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { Catalog } from '@flow-ts/catalog'
import { parseProgram } from '@flow-ts/parsing'
import { describe, expect, it } from 'vitest'
import { PlanTree } from '../src/index.js'

const EXAMPLES_DIR = '/home/knarf/projects/dbflow/flowlog/examples'
const SKIP = new Set(['crdt.dl', 'crdt_slow.dl']) // see catalog examples test

const EXAMPLE_FILES = fs
  .readdirSync(EXAMPLES_DIR)
  .filter((f) => f.endsWith('.dl'))
  .filter((f) => !SKIP.has(f))
  .sort()

describe('PlanTree.fromCatalog over every upstream example', () => {
  for (const file of EXAMPLE_FILES) {
    it(file, () => {
      const source = fs.readFileSync(path.join(EXAMPLES_DIR, file), 'utf8')
      const program = parseProgram(source, { grammarSource: file })
      for (const rule of program.rules) {
        const cat = Catalog.fromStrata(rule)
        const def = PlanTree.fromCatalog(cat, false)
        const opt = PlanTree.fromCatalog(cat, true)
        // Width should never be negative; optimized never worse than default.
        expect(def.treeWidth).toBeGreaterThanOrEqual(0)
        expect(opt.treeWidth).toBeLessThanOrEqual(def.treeWidth)
        // Each core atom must appear in subTrees.
        for (let i = 0; i < cat.isCoreAtomBitmap.length; i++) {
          if (cat.isCoreAtomBitmap[i]) {
            expect(def.subTrees.has(i)).toBe(true)
            expect(opt.subTrees.has(i)).toBe(true)
          }
        }
      }
    })
  }
})
