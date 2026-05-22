// Property: serialize → parse → serialize → parse must produce structurally
// equal programs. Run against every upstream example.

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as url from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseProgram, programToDl } from '../src/index.js'

const HERE = path.dirname(url.fileURLToPath(import.meta.url))
const EXAMPLES_DIR = path.resolve(HERE, '..', '..', '..', 'vendor', 'flowlog-examples')

const EXAMPLE_FILES = fs
  .readdirSync(EXAMPLES_DIR)
  .filter((f) => f.endsWith('.dl'))
  .sort()

describe('Program serialization round-trip', () => {
  for (const file of EXAMPLE_FILES) {
    it(file, () => {
      const source = fs.readFileSync(path.join(EXAMPLES_DIR, file), 'utf8')
      const first = parseProgram(source, { grammarSource: file })

      // Round trip 1: serialize the parsed program, parse the serialization.
      const reserialized = programToDl(first)
      const second = parseProgram(reserialized, { grammarSource: `${file} (rt1)` })

      // Round trip 2: serialize again. Output must be byte-identical to (1).
      const thirdSerialization = programToDl(second)
      expect(thirdSerialization).toBe(reserialized)

      // Structural identity: same number of EDBs / IDBs / rules.
      expect(second.edbs).toHaveLength(first.edbs.length)
      expect(second.idbs).toHaveLength(first.idbs.length)
      expect(second.rules).toHaveLength(first.rules.length)
    })
  }
})
