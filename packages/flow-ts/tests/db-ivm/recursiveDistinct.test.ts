// The recursive dedup, on its own.
//
// End-to-end coverage lives in the executing suite, where there is a real
// recursive stratum to point at. This is the protocol in isolation: what the operator
// emits, and when, given deltas it cannot see the origin of.
//
// The contract is one sentence — a tuple that loses a derivation is retracted
// on suspicion and put back only if it is still counted once the graph has
// stopped moving — and every test here is a consequence of it.

import { describe, expect, it } from 'vitest'
import { D2 } from '../../src/db-ivm/d2.js'
import { output } from '../../src/db-ivm/operators/output.js'
import { recursiveStringDistinct } from '../../src/db-ivm/operators/recursiveDistinct.js'
import { stringDistinct } from '../../src/db-ivm/operators/stringDistinct.js'
import type { MultiSet } from '../../src/db-ivm/multiset.js'

type Emission = [string, number]

/** A graph of one operator, so emissions can be read exactly as produced —
 *  order and all, which is the part that matters for a two-phase protocol. */
function harness(recursive: boolean) {
  const graph = new D2()
  const input = graph.newInput<string>()
  const seen: Emission[][] = []
  input
    .pipe(recursive ? recursiveStringDistinct() : stringDistinct())
    .pipe(
      output((data: MultiSet<string>) => {
        const batch = data.getInner().map(([v, m]) => [v, m] as Emission)
        if (batch.length > 0) seen.push(batch)
      }),
    )
  graph.finalize()

  return {
    /** Send deltas and run to a fixpoint. Returns what was emitted, flattened. */
    send(...deltas: Emission[]): Emission[] {
      seen.length = 0
      input.sendData(deltas)
      graph.run()
      return seen.flat()
    },
    /** Emissions grouped by the batch they arrived in — a retract and its
     *  matching re-assert are always separate batches, because the whole point
     *  is that the second one happens after the graph settled. */
    batches(...deltas: Emission[]): Emission[][] {
      seen.length = 0
      input.sendData(deltas)
      graph.run()
      return seen.map((b) => [...b])
    },
  }
}

describe('it is an ordinary dedup while nothing is retracted', () => {
  it('emits a value once however many times it is derived', () => {
    const h = harness(true)
    expect(h.send(['a', 1])).toEqual([['a', 1]])
    expect(h.send(['a', 1])).toEqual([])
    expect(h.send(['a', 1], ['b', 1])).toEqual([['b', 1]])
  })

  it('agrees with the plain dedup on an insert-only history', () => {
    const rec = harness(true)
    const plain = harness(false)
    const history: Emission[][] = [
      [['a', 1]],
      [['a', 1], ['b', 2]],
      [['c', 1]],
      [['b', 1], ['c', 3]],
    ]
    for (const deltas of history) {
      expect(rec.send(...deltas)).toEqual(plain.send(...deltas))
    }
  })

  it('and on retractions that take the count to zero', () => {
    const rec = harness(true)
    const plain = harness(false)
    for (const deltas of [
      [['a', 1] as Emission],
      [['b', 1] as Emission],
      [['a', -1] as Emission],
      [['b', -1] as Emission],
    ]) {
      expect(rec.send(...deltas)).toEqual(plain.send(...deltas))
    }
  })
})

describe('a retraction that leaves the count positive', () => {
  // The case the whole operator exists for. The plain dedup emits nothing
  // here, because two derivations minus one is still one. That is right when
  // the remaining derivation stands on its own and wrong when it is standing
  // on the tuple itself, and nothing local tells them apart.
  it('is where the two dedups part company', () => {
    const plain = harness(false)
    plain.send(['a', 2])
    expect(plain.send(['a', -1])).toEqual([])
  })

  it('retracts on suspicion, then puts it back when nothing knocked it down', () => {
    const rec = harness(true)
    rec.send(['a', 2])
    // Two batches, in this order: the doubt, then the answer.
    expect(rec.batches(['a', -1])).toEqual([[['a', -1]], [['a', 1]]])
  })

  it('nets to no change, which is what a caller accumulating diffs sees', () => {
    const rec = harness(true)
    rec.send(['a', 2])
    const net = new Map<string, number>()
    for (const [v, m] of rec.send(['a', -1])) net.set(v, (net.get(v) ?? 0) + m)
    expect([...net].filter(([, m]) => m !== 0)).toEqual([])
  })

  it('stays retracted when the cascade takes the rest of the count with it', () => {
    // Standing in for the cascade: the second retraction is what would come
    // back round the loop after the first one propagated.
    const rec = harness(true)
    rec.send(['a', 2])
    const emitted = rec.send(['a', -1], ['a', -1])
    const net = emitted.reduce((n, [, m]) => n + m, 0)
    expect(net).toBe(-1)
  })
})

describe('a suspect tuple is not re-asserted by the cascade itself', () => {
  // Found by the fuzzer. Once a tuple is under suspicion, further deltas about
  // it are part of the evidence, not a fresh derivation — treating a
  // still-positive count as grounds to re-assert put back exactly the tuples
  // the cascade was in the middle of proving unfounded.
  it('a second retraction in the same run does not look like an insert', () => {
    const rec = harness(true)
    rec.send(['a', 3])
    // Suspicion is raised on the first, and the second must not undo it.
    const batches = rec.batches(['a', -1])
    expect(batches[0]).toEqual([['a', -1]])
  })

  it('and the verdict is the count at the point the graph stops', () => {
    const rec = harness(true)
    rec.send(['a', 3])
    rec.send(['a', -1]) // suspect, re-asserted: count 2
    rec.send(['a', -1]) // suspect, re-asserted: count 1
    const last = rec.send(['a', -1]) // count 0: gone for good
    expect(last.reduce((n, [, m]) => n + m, 0)).toBe(-1)
    expect(rec.send(['a', -1])).toEqual([])
  })
})

describe('settling is per value, not per graph', () => {
  it('one tuple can go while another comes back in the same run', () => {
    const rec = harness(true)
    rec.send(['keep', 2], ['drop', 1])
    const net = new Map<string, number>()
    for (const [v, m] of rec.send(['keep', -1], ['drop', -1])) {
      net.set(v, (net.get(v) ?? 0) + m)
    }
    expect(net.get('drop')).toBe(-1)
    expect(net.get('keep') ?? 0).toBe(0)
  })
})
