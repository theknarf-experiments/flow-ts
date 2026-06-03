// Core MST invariants:
//   * History-independent: insertion order doesn't affect the root digest.
//   * Determinism: same key set → same root digest.
//   * Empty: rootDigest of an Mst with no keys equals EMPTY_DIGEST.
//   * Idempotent insert: re-inserting a key is a no-op.

import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { babHash } from '../../src/bab/index.js'
import { EMPTY_DIGEST, Mst, collectKeys, toHex } from '../../src/mst/index.js'

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
    fc.assert(
      fc.property(
        fc
          .uniqueArray(fc.string({ minLength: 1, maxLength: 12 }), { minLength: 1, maxLength: 25 })
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
      { numRuns: 50 },
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

  it('collectKeys yields the keys in sorted order', () => {
    const m = new Mst()
    const inputs = ['x', 'apple', 'banana', 'cherry', 'durian', 'fig', 'grape', 'kiwi']
    for (const w of inputs) m.insert(keyFrom(w))
    const walked = [...collectKeys(m.root())].map(toHex)
    const expected = [...walked].sort()
    expect(walked).toEqual(expected)
  })
})
