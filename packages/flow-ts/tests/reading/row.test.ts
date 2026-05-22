// Port of the property_tests module in flowlog/src/reading/src/row.rs.

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { isFatArity, rowArity, rowColumn, rowToString } from '../../src/reading/index.js'

const numArr = fc.array(fc.integer({ min: -(2 ** 30), max: 2 ** 30 }), {
  minLength: 1,
  maxLength: 20,
})

describe('Row', () => {
  it('column lookup returns the value pushed at each index', () => {
    fc.assert(
      fc.property(numArr, (values) => {
        for (let i = 0; i < values.length; i++) {
          if (rowColumn(values, i) !== values[i]) return false
        }
        return true
      }),
    )
  })

  it('arity tracks the row length', () => {
    fc.assert(
      fc.property(numArr, (values) => {
        return rowArity(values) === values.length
      }),
    )
  })

  it('display is comma-separated and contains each value', () => {
    fc.assert(
      fc.property(numArr, (values) => {
        const s = rowToString(values)
        for (const v of values) {
          if (!s.includes(v.toString())) return false
        }
        return true
      }),
    )
  })

  it('isFatArity flags arities above the row threshold', () => {
    expect(isFatArity(0)).toBe(false)
    expect(isFatArity(7)).toBe(false)
    expect(isFatArity(8)).toBe(true)
    expect(isFatArity(20)).toBe(true)
  })
})
