// Parse every example .dl file from the upstream FlowLog repo and confirm the
// shape of the resulting Program. This is the broad coverage test for the
// parser; targeted unit tests live in the other test files.

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as url from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseProgram } from '../src/index.js'

const HERE = path.dirname(url.fileURLToPath(import.meta.url))
const EXAMPLES_DIR = path.resolve(HERE, '..', '..', '..', 'vendor', 'flowlog-examples')

const EXAMPLE_FILES = fs
  .readdirSync(EXAMPLES_DIR)
  .filter((f) => f.endsWith('.dl'))
  .sort()

describe('parses every upstream example', () => {
  for (const file of EXAMPLE_FILES) {
    it(file, () => {
      const source = fs.readFileSync(path.join(EXAMPLES_DIR, file), 'utf8')
      const program = parseProgram(source, { grammarSource: file })
      expect(program.edbs.length + program.idbs.length).toBeGreaterThan(0)
      expect(program.rules.length).toBeGreaterThan(0)
    })
  }
})
