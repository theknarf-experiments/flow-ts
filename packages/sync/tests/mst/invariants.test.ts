// Core MST invariants:
//   * History-independent: insertion order doesn't affect the root digest.
//   * Determinism: same key set → same root digest.
//   * Empty: rootDigest of an Mst with no keys equals EMPTY_DIGEST.
//   * Idempotent insert: re-inserting a key is a no-op.

import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { babHash } from '../../src/bab/index.js'
import {
  EMPTY_DIGEST,
  Mst,
  collectKeys,
  serialisePageRanges,
  toHex,
} from '../../src/mst/index.js'

function keyFrom(s: string): Uint8Array {
  return babHash(new TextEncoder().encode(s))
}

describe('MST invariants', () => {
  it('empty tree has the empty digest', () => {
    const m = new Mst()
    expect(m.size).toBe(0)
    expect(toHex(m.rootDigest())).toBe(toHex(EMPTY_DIGEST))
  })

  it('a single key produces a non-empty root', () => {
    const m = new Mst()
    m.insert(keyFrom('hello'))
    expect(m.size).toBe(1)
    expect(toHex(m.rootDigest())).not.toBe(toHex(EMPTY_DIGEST))
  })

  it('insertion is idempotent', () => {
    const m = new Mst()
    expect(m.insert(keyFrom('a'))).toBe(true)
    expect(m.insert(keyFrom('a'))).toBe(false)
    expect(m.size).toBe(1)
  })

  it('history-independent: any permutation produces the same root digest', () => {
    // Larger sets exercise more levels. The earlier 25-key cap
    // happened to mostly produce trees with 0-1 level-1 keys —
    // not enough to exercise the splitOffLt/null-slot bug we
    // discovered in scale benchmarking. 250 keys guarantees ~16
    // level-1 keys + a level-2 key, hitting every code path.
    fc.assert(
      fc.property(
        fc
          .uniqueArray(fc.string({ minLength: 1, maxLength: 12 }), {
            minLength: 1,
            maxLength: 250,
          })
          .chain((words) =>
            fc.tuple(
              fc.constant(words),
              fc.shuffledSubarray(words, { minLength: words.length, maxLength: words.length }),
            ),
          ),
        ([words, shuffled]) => {
          const a = new Mst()
          for (const w of words) a.insert(keyFrom(w))
          const b = new Mst()
          for (const w of shuffled) b.insert(keyFrom(w))
          return toHex(a.rootDigest()) === toHex(b.rootDigest())
        },
      ),
      { numRuns: 30 },
    )
  })

  it('two MSTs differ iff their key sets differ', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 12 }), {
          minLength: 0,
          maxLength: 20,
        }),
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 12 }), {
          minLength: 0,
          maxLength: 20,
        }),
        (wordsA, wordsB) => {
          const a = new Mst()
          for (const w of wordsA) a.insert(keyFrom(w))
          const b = new Mst()
          for (const w of wordsB) b.insert(keyFrom(w))
          const sameKeys =
            wordsA.length === wordsB.length && new Set(wordsA).size === new Set([...wordsA, ...wordsB]).size
          const sameDigest = toHex(a.rootDigest()) === toHex(b.rootDigest())
          return sameKeys === sameDigest
        },
      ),
      { numRuns: 40 },
    )
  })

  it('membership: has(k) iff k was inserted (property)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 12 }), {
          minLength: 0,
          maxLength: 60,
        }),
        fc.array(fc.string({ minLength: 1, maxLength: 12 }), {
          minLength: 0,
          maxLength: 30,
        }),
        (inserted, queried) => {
          const m = new Mst()
          const insertedSet = new Set(inserted)
          for (const w of inserted) m.insert(keyFrom(w))
          if (m.size !== insertedSet.size) return false
          for (const q of queried) {
            const inMst = m.has(keyFrom(q))
            const expected = insertedSet.has(q)
            if (inMst !== expected) return false
          }
          return true
        },
      ),
      { numRuns: 40 },
    )
  })

  it('page-range serialisation is deterministic and covers every key (property)', () => {
    // Two guarantees at once:
    //   * `serialisePageRanges` output only depends on the key set,
    //     not insertion order (redundant with the digest test but
    //     covers a different code path — the pre-order walk).
    //   * The union of pages' digest sets equals the key set. No key
    //     is silently dropped by pagination.
    fc.assert(
      fc.property(
        fc
          .uniqueArray(fc.string({ minLength: 1, maxLength: 12 }), {
            minLength: 1,
            maxLength: 150,
          })
          .chain((words) =>
            fc.tuple(
              fc.constant(words),
              fc.shuffledSubarray(words, {
                minLength: words.length,
                maxLength: words.length,
              }),
            ),
          ),
        ([words, shuffled]) => {
          const a = new Mst()
          for (const w of words) a.insert(keyFrom(w))
          const b = new Mst()
          for (const w of shuffled) b.insert(keyFrom(w))
          const aRanges = serialisePageRanges(a.root())
          const bRanges = serialisePageRanges(b.root())
          if (aRanges.length !== bRanges.length) return false
          for (let i = 0; i < aRanges.length; i++) {
            if (toHex(aRanges[i]!.start) !== toHex(bRanges[i]!.start)) return false
            if (toHex(aRanges[i]!.end) !== toHex(bRanges[i]!.end)) return false
            if (toHex(aRanges[i]!.hash) !== toHex(bRanges[i]!.hash)) return false
          }
          return true
        },
      ),
      { numRuns: 25 },
    )
  })

  it('collectKeys yields the keys in sorted order', () => {
    const m = new Mst()
    const inputs = ['x', 'apple', 'banana', 'cherry', 'durian', 'fig', 'grape', 'kiwi']
    for (const w of inputs) m.insert(keyFrom(w))
    const walked = [...collectKeys(m.root())].map(toHex)
    const expected = [...walked].sort()
    expect(walked).toEqual(expected)
  })
})
