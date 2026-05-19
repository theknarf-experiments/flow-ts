// Property tests for the row encoding helpers.

import fc from 'fast-check'
import { describe, it } from 'vitest'
import { decodeRow, encodeRow, type Row } from '../src/index.js'

const numField = fc.integer({ min: -(2 ** 30), max: 2 ** 30 })
const row = fc.array(numField, { minLength: 0, maxLength: 8 })

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
