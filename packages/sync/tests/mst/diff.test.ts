// `diff(a, b)` returns exactly the symmetric difference of their key sets.

import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { babHash } from '../../src/bab/index.js'
import { Mst, diff, toHex } from '../../src/mst/index.js'

function keyFrom(s: string): Uint8Array {
  return babHash(new TextEncoder().encode(s))
}

function hexSet(keys: Uint8Array[]): Set<string> {
  return new Set(keys.map(toHex))
}

describe('MST diff', () => {
  it('two empty MSTs have no diff', () => {
    const result = diff(null, null)
    expect(result.onlyA).toEqual([])
    expect(result.onlyB).toEqual([])
  })

  it('two equal MSTs have no diff', () => {
    const a = new Mst()
    const b = new Mst()
    for (const w of ['x', 'y', 'z']) {
      a.insert(keyFrom(w))
      b.insert(keyFrom(w))
    }
    const result = diff(a.root(), b.root())
    expect(result.onlyA).toEqual([])
    expect(result.onlyB).toEqual([])
  })

  it('disjoint MSTs surface all keys per side', () => {
    const a = new Mst()
    const b = new Mst()
    for (const w of ['a1', 'a2', 'a3']) a.insert(keyFrom(w))
    for (const w of ['b1', 'b2']) b.insert(keyFrom(w))
    const result = diff(a.root(), b.root())
    expect(result.onlyA.length).toBe(3)
    expect(result.onlyB.length).toBe(2)
  })

  it('diff equals the symmetric difference for arbitrary key sets', () => {
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

          const result = diff(a.root(), b.root())
          const expectedOnlyA = [...setA].filter((w) => !setB.has(w)).map((w) => toHex(keyFrom(w)))
          const expectedOnlyB = [...setB].filter((w) => !setA.has(w)).map((w) => toHex(keyFrom(w)))

          const actualA = hexSet(result.onlyA)
          const actualB = hexSet(result.onlyB)
          const expA = new Set(expectedOnlyA)
          const expB = new Set(expectedOnlyB)

          return (
            actualA.size === expA.size &&
            [...expA].every((k) => actualA.has(k)) &&
            actualB.size === expB.size &&
            [...expB].every((k) => actualB.has(k))
          )
        },
      ),
      { numRuns: 60 },
    )
  })
})
