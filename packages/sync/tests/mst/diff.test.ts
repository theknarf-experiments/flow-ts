// Tree-aligned page-range diff. The semantics changed in the
// canonical port: `diff(local, peer)` is *one-way* — it returns the
// key ranges local should fetch from peer to converge. For the
// symmetric difference (both directions) we run two passes.

import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { babHash } from '../../src/bab/index.js'
import { Mst, compareHash, diff, keysInRanges, serialisePageRanges, toHex } from '../../src/mst/index.js'

function keyFrom(s: string): Uint8Array {
  return babHash(new TextEncoder().encode(s))
}

function sortedKeys(m: Mst): Uint8Array[] {
  return [...m.keys()].sort(compareHash)
}

/** Sym-difference oracle via direct set comparison. */
function expectedSymDiff(a: Set<string>, b: Set<string>) {
  return {
    onlyA: [...a].filter((k) => !b.has(k)),
    onlyB: [...b].filter((k) => !a.has(k)),
  }
}

describe('MST diff (page-range)', () => {
  it('two empty MSTs have no diff', () => {
    const a = new Mst()
    const b = new Mst()
    const ra = serialisePageRanges(a.root())
    const rb = serialisePageRanges(b.root())
    expect(diff(ra, rb)).toEqual([])
    expect(diff(rb, ra)).toEqual([])
  })

  it('two equal MSTs have no diff', () => {
    const a = new Mst()
    const b = new Mst()
    for (const w of ['x', 'y', 'z']) {
      a.insert(keyFrom(w))
      b.insert(keyFrom(w))
    }
    const ra = serialisePageRanges(a.root())
    const rb = serialisePageRanges(b.root())
    expect(diff(ra, rb)).toEqual([])
    expect(diff(rb, ra)).toEqual([])
  })

  it('local missing 2 keys peer has → diff has at least one range covering them', () => {
    const a = new Mst()
    const b = new Mst()
    for (const w of ['shared1', 'shared2']) {
      a.insert(keyFrom(w))
      b.insert(keyFrom(w))
    }
    b.insert(keyFrom('peer-only-1'))
    b.insert(keyFrom('peer-only-2'))
    const aRanges = serialisePageRanges(a.root())
    const bRanges = serialisePageRanges(b.root())
    // What local (a) needs to fetch from peer (b).
    const need = diff(aRanges, bRanges)
    expect(need.length).toBeGreaterThanOrEqual(1)
    const bKeys = sortedKeys(b)
    const fetched = keysInRanges(bKeys, need).map(toHex)
    // We must fetch at least the two peer-only keys.
    expect(fetched).toContain(toHex(keyFrom('peer-only-1')))
    expect(fetched).toContain(toHex(keyFrom('peer-only-2')))
  })

  it('two-pass diff yields the full symmetric difference', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 16 }), {
          minLength: 0,
          maxLength: 40,
        }),
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 16 }), {
          minLength: 0,
          maxLength: 40,
        }),
        (wordsA, wordsB) => {
          const setA = new Set(wordsA)
          const setB = new Set(wordsB)
          const a = new Mst()
          const b = new Mst()
          for (const w of setA) a.insert(keyFrom(w))
          for (const w of setB) b.insert(keyFrom(w))

          const aRanges = serialisePageRanges(a.root())
          const bRanges = serialisePageRanges(b.root())

          // A's pull from B.
          const aNeeds = diff(aRanges, bRanges)
          const aFetch = new Set(keysInRanges(sortedKeys(b), aNeeds).map(toHex))
          // B's pull from A.
          const bNeeds = diff(bRanges, aRanges)
          const bFetch = new Set(keysInRanges(sortedKeys(a), bNeeds).map(toHex))

          const expected = expectedSymDiff(setA, setB)
          const expectedOnlyA = new Set(expected.onlyA.map((s) => toHex(keyFrom(s))))
          const expectedOnlyB = new Set(expected.onlyB.map((s) => toHex(keyFrom(s))))

          // aFetch should cover everything B has that A doesn't.
          for (const k of expectedOnlyB) if (!aFetch.has(k)) return false
          // bFetch should cover everything A has that B doesn't.
          for (const k of expectedOnlyA) if (!bFetch.has(k)) return false
          return true
        },
      ),
      { numRuns: 50 },
    )
  })
})
