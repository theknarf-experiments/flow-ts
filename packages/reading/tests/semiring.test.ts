// Port of the property_tests module in flowlog/src/reading/src/semiring.rs.

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { Min, SEMIRING_TYPE, semiringOne } from '../src/index.js'

describe('Semiring', () => {
  it('semiringOne is 1', () => {
    expect(semiringOne()).toBe(1)
  })
  it('SEMIRING_TYPE is "isize"', () => {
    expect(SEMIRING_TYPE).toBe('isize')
  })
})

describe('Min', () => {
  it('plusEquals takes the minimum (example: 5 ⊕ 3 == 3)', () => {
    const a = Min.new(5)
    a.plusEquals(Min.new(3))
    expect(a.value).toBe(3)
  })

  it('infinity is the additive identity', () => {
    const inf = Min.infinity()
    inf.plusEquals(Min.new(42))
    expect(inf.value).toBe(42)
  })

  it('zero === infinity', () => {
    const zero = Min.zero()
    expect(zero.isZero()).toBe(false)
    expect(zero.isInfinity()).toBe(true)
  })

  describe('properties', () => {
    const u64 = fc.integer({ min: 0, max: 2 ** 30 })

    it('associativity: (a ⊕ b) ⊕ c == a ⊕ (b ⊕ c)', () => {
      fc.assert(
        fc.property(u64, u64, u64, (a, b, c) => {
          const ab = Min.new(a)
          ab.plusEquals(Min.new(b))
          ab.plusEquals(Min.new(c))

          const bc = Min.new(b)
          bc.plusEquals(Min.new(c))
          const aBc = Min.new(a)
          aBc.plusEquals(bc)

          return ab.value === aBc.value
        }),
      )
    })

    it('commutativity: a ⊕ b == b ⊕ a', () => {
      fc.assert(
        fc.property(u64, u64, (a, b) => {
          const ab = Min.new(a)
          ab.plusEquals(Min.new(b))
          const ba = Min.new(b)
          ba.plusEquals(Min.new(a))
          return ab.value === ba.value
        }),
      )
    })

    it('identity: a ⊕ zero == a', () => {
      fc.assert(
        fc.property(u64, (a) => {
          const r = Min.new(a)
          r.plusEquals(Min.zero())
          return r.value === a
        }),
      )
    })

    it('idempotence: a ⊕ a == a', () => {
      fc.assert(
        fc.property(u64, (a) => {
          const r = Min.new(a)
          r.plusEquals(Min.new(a))
          return r.value === a
        }),
      )
    })

    it('infinity absorbs (returns the finite value)', () => {
      const finite = fc.integer({ min: 0, max: 2 ** 30 })
      fc.assert(
        fc.property(finite, (a) => {
          const r = Min.new(a)
          r.plusEquals(Min.infinity())
          return r.value === a
        }),
      )
    })

    it('isZero is always false', () => {
      fc.assert(
        fc.property(u64, (a) => {
          return Min.new(a).isZero() === false
        }),
      )
    })
  })
})
