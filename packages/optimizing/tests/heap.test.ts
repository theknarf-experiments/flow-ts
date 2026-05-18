import { describe, expect, it } from 'vitest'
import { MaxHeap } from '../src/index.js'

describe('MaxHeap', () => {
  it('pops elements in descending order under a numeric comparator', () => {
    const h = new MaxHeap<number>((a, b) => a - b)
    for (const n of [5, 1, 9, 2, 8, 3]) h.push(n)
    const out: number[] = []
    while (h.size > 0) out.push(h.pop()!)
    expect(out).toEqual([9, 8, 5, 3, 2, 1])
  })

  it('returns undefined on empty pop', () => {
    const h = new MaxHeap<number>((a, b) => a - b)
    expect(h.pop()).toBeUndefined()
  })

  it('respects compound comparators (lex)', () => {
    // Higher first field; ties broken by lower second field.
    const h = new MaxHeap<[number, number]>((a, b) => {
      if (a[0] !== b[0]) return a[0] - b[0]
      return b[1] - a[1]
    })
    h.push([1, 5])
    h.push([1, 2])
    h.push([2, 9])
    h.push([2, 1])
    h.push([0, 3])
    const out: [number, number][] = []
    while (h.size > 0) out.push(h.pop()!)
    expect(out).toEqual([
      [2, 1],
      [2, 9],
      [1, 2],
      [1, 5],
      [0, 3],
    ])
  })
})
