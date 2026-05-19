// Property-based tests for the executor. Cover invariants that should
// hold for any program / fact-set, against generated input.
//
// Properties exercised:
//   • Streaming ≡ batch: same net IDB state regardless of how facts
//     are introduced (one big batch, one per advance, retract+re-insert).
//   • Idempotence: running the same program+facts twice in fresh
//     sessions gives the same output.
//   • Transitive closure matches a reference BFS over random graphs.
//   • `noSharing: true` produces the same output as `noSharing: false`
//     for the same inputs.

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parseProgram } from '@flow-ts/parsing'
import type { Row } from '@flow-ts/reading'
import { executeProgram, openSession, type ExecuteOptions, type IdbSink } from '../src/index.js'

// Programs we'll reuse across multiple properties.
const REACH_PROGRAM = parseProgram(
  `\
.in
.decl Source(id: number)
.input Source.csv

.decl Arc(x: number, y: number)
.input Arc.csv

.printsize
.decl Reach(id: number)

.rule
Reach(y) :- Source(y).
Reach(y) :- Reach(x), Arc(x, y).
`,
  { grammarSource: 'reach.dl' },
)

const TC_PROGRAM = parseProgram(
  `\
.in
.decl Arc(x: number, y: number)
.input Arc.csv

.printsize
.decl Tc(x: number, y: number)

.rule
Tc(x, y) :- Arc(x, y).
Tc(x, z) :- Tc(x, y), Arc(y, z).
`,
  { grammarSource: 'tc.dl' },
)

/** Run a program through `executeProgram` and return the set of live IDB
 *  rows (positive net multiplicity). Strings: `<rel>|<csv>`. */
function liveSet(
  program: typeof REACH_PROGRAM,
  facts: Record<string, Row[]>,
  options: ExecuteOptions = {},
): Set<string> {
  const seen = new Map<string, number>()
  const sink: IdbSink = (rel, row, diff) => {
    const k = `${rel}|${row.map((v) => v.toString()).join(',')}`
    seen.set(k, (seen.get(k) ?? 0) + diff)
  }
  executeProgram(program, new Map(Object.entries(facts)), options, sink)
  const live = new Set<string>()
  for (const [k, n] of seen) if (n > 0) live.add(k)
  return live
}

// --- Generators ---

/** A small graph: up to N nodes, each edge with probability ~0.4. */
const graphGen = fc
  .integer({ min: 0, max: 6 })
  .chain((nodeCount) =>
    fc.array(
      fc.tuple(
        fc.integer({ min: 0, max: Math.max(nodeCount - 1, 0) }),
        fc.integer({ min: 0, max: Math.max(nodeCount - 1, 0) }),
      ),
      { minLength: 0, maxLength: nodeCount * 2 },
    ),
  )

const sourcesGen = fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 0, maxLength: 4 })

// --- Properties ---

describe('streaming ≡ batch', () => {
  it('reach.dl: any update order yields the same live set', () => {
    fc.assert(
      fc.property(sourcesGen, graphGen, (sources, edges) => {
        const facts: Record<string, Row[]> = {
          Source: sources.map((v) => [v]),
          Arc: edges.map(([a, b]) => [a, b]),
        }
        const batch = liveSet(REACH_PROGRAM, facts)

        // Streaming: one update per `advance()`.
        const seen = new Map<string, number>()
        const session = openSession(REACH_PROGRAM, {}, (rel, row, diff) => {
          const k = `${rel}|${row.map((v) => v.toString()).join(',')}`
          seen.set(k, (seen.get(k) ?? 0) + diff)
        })
        for (const [v] of facts.Source!) {
          session.update('Source', [v])
          session.advance()
        }
        for (const [a, b] of facts.Arc!) {
          session.update('Arc', [a, b])
          session.advance()
        }
        session.close()
        const streamed = new Set<string>()
        for (const [k, n] of seen) if (n > 0) streamed.add(k)

        return setsEqual(batch, streamed)
      }),
      { numRuns: 30 },
    )
  })

  it('reach.dl: insert + retract + re-insert ≡ batch', () => {
    fc.assert(
      fc.property(sourcesGen, graphGen, (sources, edges) => {
        const facts: Record<string, Row[]> = {
          Source: sources.map((v) => [v]),
          Arc: edges.map(([a, b]) => [a, b]),
        }
        const batch = liveSet(REACH_PROGRAM, facts)

        const seen = new Map<string, number>()
        const session = openSession(REACH_PROGRAM, {}, (rel, row, diff) => {
          const k = `${rel}|${row.map((v) => v.toString()).join(',')}`
          seen.set(k, (seen.get(k) ?? 0) + diff)
        })
        // Insert everything.
        for (const [v] of facts.Source!) session.update('Source', [v])
        for (const [a, b] of facts.Arc!) session.update('Arc', [a, b])
        session.advance()
        // Retract everything.
        for (const [v] of facts.Source!) session.update('Source', [v], -1)
        for (const [a, b] of facts.Arc!) session.update('Arc', [a, b], -1)
        session.advance()
        // Re-insert everything.
        for (const [v] of facts.Source!) session.update('Source', [v])
        for (const [a, b] of facts.Arc!) session.update('Arc', [a, b])
        session.close()

        const live = new Set<string>()
        for (const [k, n] of seen) if (n > 0) live.add(k)
        return setsEqual(batch, live)
      }),
      { numRuns: 20 },
    )
  })
})

describe('idempotence', () => {
  it('executeProgram twice on identical inputs gives identical output', () => {
    fc.assert(
      fc.property(sourcesGen, graphGen, (sources, edges) => {
        const facts: Record<string, Row[]> = {
          Source: sources.map((v) => [v]),
          Arc: edges.map(([a, b]) => [a, b]),
        }
        const a = liveSet(REACH_PROGRAM, facts)
        const b = liveSet(REACH_PROGRAM, facts)
        return setsEqual(a, b)
      }),
      { numRuns: 30 },
    )
  })
})

describe('TC matches reference BFS', () => {
  it('tc.dl produces exactly the reachable-pair set', () => {
    fc.assert(
      fc.property(graphGen, (edges) => {
        const facts = { Arc: edges.map(([a, b]) => [a, b] as Row) }
        const tc = liveSet(TC_PROGRAM, facts)
        const expected = referenceTc(edges)
        return setsEqual(tc, expected)
      }),
      { numRuns: 40 },
    )
  })
})

describe('noSharing equivalence', () => {
  it('noSharing=true and noSharing=false produce the same live set', () => {
    fc.assert(
      fc.property(sourcesGen, graphGen, (sources, edges) => {
        const facts: Record<string, Row[]> = {
          Source: sources.map((v) => [v]),
          Arc: edges.map(([a, b]) => [a, b]),
        }
        const shared = liveSet(REACH_PROGRAM, facts, { noSharing: false })
        const unshared = liveSet(REACH_PROGRAM, facts, { noSharing: true })
        return setsEqual(shared, unshared)
      }),
      { numRuns: 25 },
    )
  })
})

// --- Helpers ---

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

/** BFS-based transitive closure. Reference implementation for the
 *  `Tc(x,y) :- Arc(x,y)` / `Tc(x,z) :- Tc(x,y), Arc(y,z)` program. */
function referenceTc(edges: readonly [number, number][]): Set<string> {
  // Dedupe edges and build adjacency.
  const uniqEdges = new Set<string>()
  for (const [a, b] of edges) uniqEdges.add(`${a},${b}`)
  const adj = new Map<number, Set<number>>()
  for (const e of uniqEdges) {
    const [a, b] = e.split(',').map(Number)
    if (!adj.has(a!)) adj.set(a!, new Set())
    adj.get(a!)!.add(b!)
  }
  const reachable = new Set<string>()
  for (const src of new Set([...edges.map(([a]) => a)])) {
    const queue = [src]
    const seen = new Set<number>()
    while (queue.length > 0) {
      const x = queue.shift()!
      for (const y of adj.get(x) ?? []) {
        if (seen.has(y)) continue
        seen.add(y)
        reachable.add(`Tc|${src},${y}`)
        queue.push(y)
      }
    }
  }
  return reachable
}
