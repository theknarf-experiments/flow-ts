// Tests for the range-based reconciliation primitives.

import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { babHash } from '../../src/bab/index.js'
import { compareHash, toHex } from '../../src/mst/index.js'
import {
  ALL_ONES,
  bisect,
  inRange,
  lowerBound,
  rangeDigest,
  rangeSummary,
  sliceRange,
  ZERO_HASH,
} from '../../src/mst/range.js'

const enc = new TextEncoder()
const keyOf = (s: string) => babHash(enc.encode(s))

function sortedKeysFrom(words: string[]): Uint8Array[] {
  return words.map(keyOf).sort(compareHash)
}

describe('range bisection', () => {
  it('the full range bisects to a high-bit-set midpoint', () => {
    const mid = bisect(ZERO_HASH, null)
    expect(mid).not.toBeNull()
    // Mid should be 2^255 = 0x80, 0x00, ...
    expect(mid![0]).toBe(0x80)
    for (let i = 1; i < 32; i++) expect(mid![i]).toBe(0)
  })

  it('bisects to a value strictly between lo and hi', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        (a, b) => {
          // Ensure a < b
          if (compareHash(a, b) === 0) return true
          const [lo, hi] = compareHash(a, b) < 0 ? [a, b] : [b, a]
          const mid = bisect(lo, hi)
          if (mid === null) return true // atomic — nothing to verify
          return compareHash(lo, mid) < 0 && compareHash(mid, hi) < 0
        },
      ),
      { numRuns: 50 },
    )
  })

  it('bisect handles the upper-half range correctly', () => {
    const lo = new Uint8Array(32)
    lo[0] = 0x80
    const hi = ALL_ONES
    const mid = bisect(lo, hi)
    expect(mid).not.toBeNull()
    expect(mid![0]).toBe(0xbf)
  })
})

describe('rangeDigest', () => {
  it('empty range has a stable digest', () => {
    const a = rangeDigest([])
    const b = rangeDigest([])
    expect(toHex(a)).toBe(toHex(b))
  })

  it('digest is sensitive to key set', () => {
    const k1 = keyOf('x')
    const k2 = keyOf('y')
    const a = rangeDigest([k1])
    const b = rangeDigest([k1, k2].sort(compareHash))
    expect(toHex(a)).not.toBe(toHex(b))
  })

  it('digest depends only on contents, not how the slice was produced', () => {
    const keys = sortedKeysFrom(['a', 'b', 'c', 'd', 'e'])
    const { keys: slice1 } = sliceRange(keys, ZERO_HASH, null)
    expect(toHex(rangeDigest(slice1))).toBe(toHex(rangeDigest([...keys])))
  })
})

describe('sliceRange', () => {
  it('full range returns all keys', () => {
    const keys = sortedKeysFrom(['a', 'b', 'c'])
    const { keys: slice } = sliceRange(keys, ZERO_HASH, null)
    expect(slice.length).toBe(3)
  })

  it('inRange is consistent with sliceRange', () => {
    const keys = sortedKeysFrom(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
    const lo = keys[2]!
    const hi = keys[5]! // exclusive
    const { keys: slice } = sliceRange(keys, lo, hi)
    for (const k of slice) expect(inRange(k, lo, hi)).toBe(true)
    for (const k of keys) {
      if (compareHash(k, lo) < 0 || compareHash(k, hi) >= 0) {
        expect(inRange(k, lo, hi)).toBe(false)
      }
    }
  })
})

describe('rangeSummary', () => {
  it('two peers with the same key set in a range produce the same digest', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 12 }), {
          minLength: 1,
          maxLength: 20,
        }),
        (words) => {
          const keysA = sortedKeysFrom(words)
          // B: same keys, different insertion order — irrelevant for the digest
          const keysB = sortedKeysFrom([...words].reverse())
          // Pick a sub-range bracketed by two of the keys
          const lo = keysA[Math.floor(keysA.length / 3)]!
          const hi: Uint8Array | null =
            keysA.length > 1 ? keysA[Math.floor((2 * keysA.length) / 3)]! : null
          const a = rangeSummary(keysA, lo, hi)
          const b = rangeSummary(keysB, lo, hi)
          return toHex(a.digest) === toHex(b.digest) && a.count === b.count
        },
      ),
      { numRuns: 50 },
    )
  })
})

describe('lowerBound', () => {
  it('returns position of first key >= bound', () => {
    const keys = sortedKeysFrom(['a', 'b', 'c', 'd', 'e'])
    expect(lowerBound(keys, ZERO_HASH)).toBe(0)
    expect(lowerBound(keys, ALL_ONES)).toBe(keys.length)
    expect(lowerBound(keys, keys[2]!)).toBe(2)
  })
})
