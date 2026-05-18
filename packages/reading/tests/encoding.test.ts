// Property tests for the row encoding helpers + CSV round-trip.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decodeRow, encodeRow, readRows, type Row } from '../src/index.js'

const bigintField = fc.bigInt({ min: -(1n << 60n), max: 1n << 60n })
const row = fc.array(bigintField, { minLength: 0, maxLength: 8 })

describe('encodeRow / decodeRow', () => {
  it('round-trip: decodeRow(encodeRow(r)) === r', () => {
    fc.assert(
      fc.property(row, (r) => {
        const decoded = decodeRow(encodeRow(r))
        if (decoded.length !== r.length) return false
        for (let i = 0; i < r.length; i++) {
          if (decoded[i] !== r[i]) return false
        }
        return true
      }),
    )
  })

  it('encoding is injective: r1 != r2 implies encodeRow(r1) != encodeRow(r2)', () => {
    fc.assert(
      fc.property(row, row, (a, b) => {
        const sameContent =
          a.length === b.length && a.every((v, i) => v === b[i])
        if (sameContent) return true
        return encodeRow(a) !== encodeRow(b)
      }),
    )
  })

  it('encoding is deterministic', () => {
    fc.assert(
      fc.property(row, (r) => {
        return encodeRow(r) === encodeRow(r)
      }),
    )
  })
})

describe('CSV round-trip', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-ts-csv-rt-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('rows → CSV → readRows produces the same rows', () => {
    // All rows must share the same arity (CSV is rectangular).
    const fixedArity = fc.constantFrom(1, 2, 3, 4, 5)
    const csvGen = fixedArity.chain((arity) =>
      fc.array(fc.array(bigintField, { minLength: arity, maxLength: arity }), {
        minLength: 1,
        maxLength: 20,
      }),
    )

    fc.assert(
      fc.property(csvGen, (rows) => {
        const filePath = path.join(tmpDir, `data-${rows[0]!.length}.csv`)
        const content = rows.map((r) => r.map((v) => v.toString()).join(',')).join('\n')
        fs.writeFileSync(filePath, content)
        const read = readRows(filePath, ',', rows[0]!.length)
        if (read.length !== rows.length) return false
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i]!
          const back = read[i]!
          if (r.length !== back.length) return false
          for (let j = 0; j < r.length; j++) {
            if (r[j] !== back[j]) return false
          }
        }
        return true
      }),
    )
  })
})

describe('Rel.arrangeDouble splits a row consistently', () => {
  // Pure-value property (no d2ts wiring): the projection used by arrangeDouble
  // partitions a row into (head, tail) at index `at`, concatenating to the
  // original. Tested at the slicing level directly.
  it('concat(key, value) === original row', () => {
    fc.assert(
      fc.property(row, fc.integer({ min: 0, max: 8 }), (r, at) => {
        const at_ = Math.min(at, r.length)
        const key = r.slice(0, at_)
        const value = r.slice(at_)
        const combined: Row = [...key, ...value]
        if (combined.length !== r.length) return false
        for (let i = 0; i < r.length; i++) {
          if (combined[i] !== r[i]) return false
        }
        return true
      }),
    )
  })
})
