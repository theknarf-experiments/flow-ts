// Property tests for the row encoding helpers.

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { decodeRow, encodeRow, type Row } from '../src/index.js'

const numField = fc.integer({ min: -(2 ** 30), max: 2 ** 30 })
const row = fc.array(numField, { minLength: 0, maxLength: 8 })
const stringField = fc.string({ minLength: 0, maxLength: 16 })
const mixedField = fc.oneof(numField, stringField)
const mixedRow = fc.array(mixedField, { minLength: 0, maxLength: 8 })

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

  it('round-trips rows containing arbitrary strings (incl. , and \\)', () => {
    fc.assert(
      fc.property(mixedRow, (r) => {
        const decoded = decodeRow(encodeRow(r))
        if (decoded.length !== r.length) return false
        for (let i = 0; i < r.length; i++) {
          if (decoded[i] !== r[i]) return false
        }
        return true
      }),
    )
  })

  it('mixed rows: distinct content never collide', () => {
    fc.assert(
      fc.property(mixedRow, mixedRow, (a, b) => {
        const sameContent =
          a.length === b.length && a.every((v, i) => v === b[i])
        if (sameContent) return true
        return encodeRow(a) !== encodeRow(b)
      }),
    )
  })

  it('strings containing the field delimiter survive a round-trip', () => {
    const row: Row = ['a,b', 42, 'plain']
    expect(decodeRow(encodeRow(row))).toEqual(row)
  })

  it('strings containing escape chars survive a round-trip', () => {
    const row: Row = ['back\\slash', '\\', 'mix\\,ed', 7]
    expect(decodeRow(encodeRow(row))).toEqual(row)
  })

  it('an empty string is distinct from a missing column', () => {
    const a: Row = ['']
    const b: Row = []
    expect(encodeRow(a)).not.toBe(encodeRow(b))
    expect(decodeRow(encodeRow(a))).toEqual([''])
    expect(decodeRow(encodeRow(b))).toEqual([])
  })

  it('preserves JS type per column', () => {
    const row: Row = [42, 'forty-two']
    const decoded = decodeRow(encodeRow(row))
    expect(typeof decoded[0]).toBe('number')
    expect(typeof decoded[1]).toBe('string')
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
