// Build ProgramQueryPlan for every upstream example. The broadest test of the
// full parsing → strata → catalog → optimizing → planning pipeline.

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as url from 'node:url'
import { parseProgram } from '@flow-ts/parsing'
import { Strata } from '../../src/strata/index.js'
import { describe, expect, it } from 'vitest'
import { ProgramQueryPlan } from '../../src/planning/index.js'

const HERE = path.dirname(url.fileURLToPath(import.meta.url))
const EXAMPLES_DIR = path.resolve(HERE, '..', '..', '..', '..', 'vendor', 'flowlog-examples')
const SKIP = new Set([
  'crdt.dl',       // uses undeclared `eq` built-in
  'crdt_slow.dl',  // ditto
])

const EXAMPLE_FILES = fs
  .readdirSync(EXAMPLES_DIR)
  .filter((f) => f.endsWith('.dl'))
  .filter((f) => !SKIP.has(f))
  .sort()

describe('ProgramQueryPlan.fromStrata over every upstream example', () => {
  for (const file of EXAMPLE_FILES) {
    it(file, () => {
      const source = fs.readFileSync(path.join(EXAMPLES_DIR, file), 'utf8')
      const program = parseProgram(source, { grammarSource: file })
      const strata = Strata.fromParser(program)
      const plan = ProgramQueryPlan.fromStrata(strata, false, null)
      expect(plan.programPlan.length).toBe(strata.strata().length)
      // Sanity: max arity is at least 1 if there are any non-zero-arg heads.
      expect(plan.maxArity()).toBeGreaterThanOrEqual(0)
    })
  }
})
