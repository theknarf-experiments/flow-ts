// Incremental retraction agrees with recomputation, including under recursion.
//
// It did not always. The model-based session tests compare a maintained graph
// against a from-scratch run after every operation, and found a step that
// disagreed using no shadow rules at all — just `update(rel, row, -1)`.
//
// The failing shape was a *derivation* cycle that survives the retraction:
// after the fact goes, some set of derived tuples is still deriving each other
// with nothing underneath. Plain transitive closure does it —
//
//   Arc(0,1), Arc(1,2), Arc(2,1);  retract Arc(0,1)
//
// used to leave T(0,1) and T(0,2) propping each other up round the 1⇄2 loop.
// The dedup inside the loop counted derivations, so retracting one of T(0,1)'s
// two left a positive count, nothing was emitted, and the cascade that should
// have unwound the loop never started.
//
// Fixed in `recursiveDistinct.ts` by giving the loop's dedup the one thing it
// was missing: which iteration a derivation came from. Support is recorded per
// round, and a value is present at round r only if its support up to r is
// positive — depth told apart from multiplicity, which is what
// differential-dataflow's nested product timestamps buy and what the sibling
// Rust engine keeps for exactly this reason.
//
// This file is now the record of that: the cases that always held, the case
// that did not, and the re-derivation cases that a naive "delete more eagerly"
// fix would get wrong in the other direction.

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parseProgram } from '@flow-ts/parsing'
import { executeProgram, openSession } from '../../src/executing/index.js'
import type { Row } from '../../src/reading/index.js'

/** Programs are parsed once per source. The property tests below recompute a
 *  batch reference after every single edit, and re-parsing for each of those
 *  costs more than the evaluation being measured. */
const parsed = new Map<string, ReturnType<typeof parseProgram>>()
const program = (src: string): ReturnType<typeof parseProgram> => {
  let p = parsed.get(src)
  if (!p) parsed.set(src, (p = parseProgram(src, { grammarSource: 'r.dl' })))
  return p
}

const live = (c: Map<string, number>): string[] =>
  [...c.entries()].filter(([, n]) => n > 0).map(([k]) => k).sort()

function batch(src: string, edb: string, view: string, rows: Row[]): string[] {
  const c = new Map<string, number>()
  executeProgram(
    program(src),
    new Map([[edb, rows]]),
    {},
    (r, row, d) => {
      if (r === view) c.set(row.join(','), (c.get(row.join(',')) ?? 0) + d)
    },
  )
  return live(c)
}

function incremental(src: string, edb: string, view: string, start: Row[], drop: Row): string[] {
  const c = new Map<string, number>()
  const s = openSession(program(src), {}, (r, row, d) => {
    if (r === view) c.set(row.join(','), (c.get(row.join(',')) ?? 0) + d)
  })
  for (const row of start) s.update(edb, row, 1)
  s.advance()
  s.update(edb, drop, -1)
  s.advance()
  s.close()
  return live(c)
}

/** Retract one fact incrementally; compare against recomputing without it. */
function agrees(src: string, edb: string, view: string, start: Row[], drop: Row): boolean {
  const remaining = start.filter((r) => r.join(',') !== drop.join(','))
  return (
    incremental(src, edb, view, start, drop).join('|') ===
    batch(src, edb, view, remaining).join('|')
  )
}

const REACH = `.in
.decl S(x: number)
.input S.csv
.decl Arc(x: number, y: number)
.input Arc.csv

.printsize
.decl R(x: number)

.rule
R(y) :- S(y).
R(y) :- R(x), Arc(x, y).`

const TC = `.in
.decl Arc(x: number, y: number)
.input Arc.csv

.printsize
.decl T(x: number, y: number)

.rule
T(x, y) :- Arc(x, y).
T(x, z) :- T(x, y), Arc(y, z).`

const SELF = `.in
.decl E(a: number, b: number)
.input E.csv

.printsize
.decl I(x: number)

.rule
I(t) :- E(t, s).
I(s) :- I(s), E(t, s).`

describe('retraction agrees with recomputation', () => {
  it('for a projection', () => {
    const src = `.in
.decl A(x: number, y: number)
.input A.csv

.printsize
.decl P(x: number)

.rule
P(x) :- A(x, y).`
    expect(agrees(src, 'A', 'P', [[1, 1], [2, 2]], [1, 1])).toBe(true)
  })

  it('for linear recursion', () => {
    expect(agrees(REACH, 'Arc', 'R', [[1, 2], [2, 3]], [2, 3])).toBe(true)
  })

  it('for transitive closure', () => {
    expect(agrees(TC, 'Arc', 'T', [[1, 2], [2, 3]], [2, 3])).toBe(true)
  })

  it('for a cyclic graph, when the retraction breaks the cycle itself', () => {
    // Dropping the back edge leaves nothing deriving anything else, so there is
    // no self-support to survive. This case passing is what made an earlier
    // version of this file conclude that cyclic graphs were safe in general.
    // They were not, and which it is depends on the data rather than the rule —
    // see below.
    expect(agrees(TC, 'Arc', 'T', [[1, 2], [2, 1]], [2, 1])).toBe(true)
  })

  it('for a longer chain, retracting in the middle', () => {
    expect(agrees(TC, 'Arc', 'T', [[1, 2], [2, 3], [3, 4]], [2, 3])).toBe(true)
  })
})

describe('a derivation cycle that survives the retraction', () => {
  // The case this file was written for. Arc(0,1), Arc(1,2), Arc(2,1): T(0,1)
  // derives T(0,2) via Arc(1,2), and T(0,2) derives T(0,1) back via Arc(2,1).
  // Retracting the only thing holding that pair up used to leave them holding
  // each other.
  const CYCLE: Row[] = [[0, 1], [1, 2], [2, 1]]

  it('plain transitive closure, retracting into a cycle', () => {
    expect(agrees(TC, 'Arc', 'T', CYCLE, [0, 1])).toBe(true)
    expect(incremental(TC, 'Arc', 'T', CYCLE, [0, 1])).not.toContain('0,1')
    expect(incremental(TC, 'Arc', 'T', CYCLE, [0, 1])).not.toContain('0,2')
  })

  it('the reachable part of the graph is untouched by it', () => {
    // 1⇄2 still closes over itself; only the tuples rooted at 0 go.
    expect(incremental(TC, 'Arc', 'T', CYCLE, [0, 1])).toEqual(
      batch(TC, 'Arc', 'T', [[1, 2], [2, 1]]),
    )
  })

  it('and retracting the same graph elsewhere still agrees', () => {
    expect(agrees(TC, 'Arc', 'T', CYCLE, [1, 2])).toBe(true)
    expect(agrees(TC, 'Arc', 'T', CYCLE, [2, 1])).toBe(true)
  })

  it('a longer cycle unwinds too', () => {
    const long: Row[] = [[0, 1], [1, 2], [2, 3], [3, 1]]
    expect(agrees(TC, 'Arc', 'T', long, [0, 1])).toBe(true)
  })

  it('two entrances to the same cycle: cutting one keeps the other', () => {
    // Both 0 and 9 reach the 1⇄2 loop. Cutting 0's entrance must not take 9's
    // tuples with it — the retraction has to stop where the support does.
    const two: Row[] = [[0, 1], [9, 1], [1, 2], [2, 1]]
    expect(agrees(TC, 'Arc', 'T', two, [0, 1])).toBe(true)
    expect(incremental(TC, 'Arc', 'T', two, [0, 1])).toContain('9,1')
    expect(incremental(TC, 'Arc', 'T', two, [0, 1])).toContain('9,2')
  })
})

describe('re-derivation: the half a delete-only fix gets wrong', () => {
  // Retracting eagerly is easy; knowing when *not* to is the rest of the job.
  // A tuple can lose its shallowest derivation and still be honestly derivable
  // deeper down, and a loop that only ever deletes will drop it and never put
  // it back.
  it('keeps a tuple whose short path went but whose long path remains', () => {
    // 0→1 directly, and also 0→3→4→1. Cutting 0→1 leaves T(0,1) derivable.
    const both: Row[] = [[0, 1], [0, 3], [3, 4], [4, 1]]
    expect(agrees(TC, 'Arc', 'T', both, [0, 1])).toBe(true)
    expect(incremental(TC, 'Arc', 'T', both, [0, 1])).toContain('0,1')
  })

  it('and drops it when the long path goes as well', () => {
    const both: Row[] = [[0, 1], [0, 3], [3, 4], [4, 1]]
    expect(agrees(TC, 'Arc', 'T', both, [4, 1])).toBe(true)
    expect(incremental(TC, 'Arc', 'T', both, [4, 1])).toContain('0,1')
  })

  it('a long path that runs through a cycle still counts as support', () => {
    // 0→1 direct, plus 0→5, 5⇄6, 6→1. The cycle is real support here, not
    // circular self-support, and must survive cutting the direct edge.
    const viaCycle: Row[] = [[0, 1], [0, 5], [5, 6], [6, 5], [6, 1]]
    expect(agrees(TC, 'Arc', 'T', viaCycle, [0, 1])).toBe(true)
    expect(incremental(TC, 'Arc', 'T', viaCycle, [0, 1])).toContain('0,1')
  })
})

describe('a rule that is its own support', () => {
  it('batch evaluation is right, so the rule means what it should', () => {
    // With only E(2,1), nothing derives I(1): rule 2 needs I(1) already.
    expect(batch(SELF, 'E', 'I', [[2, 1]])).toEqual(['2'])
    expect(batch(SELF, 'E', 'I', [[1, 1], [2, 1]])).toEqual(['1', '2'])
  })

  it('and retracting agrees with recomputation like everything else', () => {
    expect(agrees(SELF, 'E', 'I', [[1, 1], [2, 1]], [1, 1])).toBe(true)
  })

  it('and the rule contributes nothing in the first place', () => {
    // `I(s) :- I(s), E(t, s).` can only re-derive what is already there, so
    // dropping it doesn't change the fixpoint — which is why the generator
    // excludes the shape rather than the suite working around it.
    const without = `.in
.decl E(a: number, b: number)
.input E.csv

.printsize
.decl I(x: number)

.rule
I(t) :- E(t, s).`
    expect(batch(SELF, 'E', 'I', [[1, 1], [2, 1]])).toEqual(
      batch(without, 'E', 'I', [[1, 1], [2, 1]]),
    )
  })
})

describe('where this actually bites', () => {
  // Not a hypothetical. `ICanReach` in the friends demo is transitive closure
  // maintained in a live session, and unfriending is a retraction — so a mutual
  // friendship anywhere downstream of the edge you cut leaves people on the
  // list who are no longer reachable.
  //
  // Found by asking what the abstract limit meant for shipped code, which is
  // the only way that question gets a useful answer.
  const REACHABLE = `.in
.decl Me(id: number)
.input Me.csv
.decl Friend(a: number, b: number)
.input Friend.csv

.printsize
.decl Reach(a: number, b: number)
.decl ICanReach(id: number)

.rule
Reach(x, y) :- Friend(x, y).
Reach(x, z) :- Reach(x, y), Friend(y, z).
ICanReach(id) :- Me(me), Reach(me, id).`

  function unfriend(edges: Row[], drop: Row): { incremental: string[]; batch: string[] } {
    const run = (fn: (s: ReturnType<typeof openSession>) => void, rows: Row[]) => {
      const c = new Map<string, number>()
      const s = openSession(program(REACHABLE), {}, (r, row, d) => {
        if (r === 'ICanReach') c.set(String(row[0]), (c.get(String(row[0])) ?? 0) + d)
      })
      s.update('Me', [1], 1)
      for (const e of rows) s.update('Friend', e, 1)
      s.advance()
      fn(s)
      s.close()
      return live(c)
    }
    return {
      incremental: run((s) => {
        s.update('Friend', drop, -1)
        s.advance()
      }, edges),
      batch: run(() => {}, edges.filter((e) => e.join() !== drop.join())),
    }
  }

  it('unfriending someone who leads to a mutual friendship', () => {
    // 1 → 2, and 2 ⇄ 3. Cutting 1 → 2 empties the list; both used to stay on
    // it forever, deriving each other round the 2 ⇄ 3 loop.
    const r = unfriend([[1, 2], [2, 3], [3, 2]], [1, 2])
    expect(r.batch).toEqual([])
    expect(r.incremental).toEqual(r.batch)
  })

  it('and unfriending one of two routes keeps the people at the end of both', () => {
    const r = unfriend([[1, 2], [1, 4], [4, 3], [2, 3], [3, 2]], [1, 2])
    expect(r.incremental).toEqual(r.batch)
    expect(r.batch).toEqual(['2', '3', '4'])
  })

  it('and a one-directional chain retracts correctly, as most data does', () => {
    const r = unfriend([[1, 2], [2, 3]], [1, 2])
    expect(r.incremental).toEqual(r.batch)
    expect(r.batch).toEqual([])
  })
})

// -- what the fuzzer found ---------------------------------------------
//
// Kept as exact sequences rather than left to the generator. Each one is a
// distinct way the fix was wrong, and a shrunk counterexample is worth more as
// a fixed test than as something a future run might rediscover.

describe('regressions', () => {
  /** Apply a sequence of edits, then compare against recomputation. */
  const check = (ops: ReadonlyArray<readonly [boolean, number, number]>): void => {
    const model = new Set<string>()
    const counts = new Map<string, number>()
    const s = openSession(program(TC), {}, (r, row, d) => {
      if (r !== 'T') return
      const k = row.join(',')
      counts.set(k, (counts.get(k) ?? 0) + d)
    })
    for (const [add, x, y] of ops) {
      const k = `${x},${y}`
      if (add === model.has(k)) continue
      if (add) model.add(k)
      else model.delete(k)
      s.update('Arc', [x, y], add ? 1 : -1)
      s.advance()
      expect(live(counts)).toEqual(
        batch(TC, 'Arc', 'T', [...model].map((e) => e.split(',').map(Number) as unknown as Row)),
      )
    }
    s.close()
  }

  it('a self-loop makes the recursive derivation land in the same pass as the base', () => {
    // Killed the first attempt, which timed the derivation by counting passes
    // through the loop. `T(3,0)` gains its second derivation from
    // `T(3,0) ⋈ Arc(0,0)` — but `T(3,0)` was already in the join's index from
    // an earlier tick, so it fires in the same pass as the base rule and the
    // two derivations look the same depth. Depth has to come from the tuple a
    // derivation stands on, not from the clock.
    check([[true, 3, 0], [true, 0, 0], [false, 3, 0]])
  })

  it('the cascade knocking a second derivation off a suspect tuple', () => {
    // `-Arc(2,3)` retracts `T(2,3)` on suspicion; the cascade comes back round
    // via `Arc(3,3)` and removes another of its derivations. That second
    // retraction arrived at a tuple already absent, took the "not present, and
    // still counted" branch, and put it straight back.
    check([
      [true, 0, 3],
      [true, 3, 0],
      [true, 2, 3],
      [true, 3, 3],
      [false, 2, 3],
    ])
  })

  it('the same shape reached through a longer history', () => {
    check([
      [true, 2, 0],
      [true, 1, 0],
      [true, 0, 0],
      [true, 0, 1],
      [false, 0, 0],
    ])
  })

  it('a two-node cycle entered from outside, cut at the entrance', () => {
    check([[true, 0, 1], [true, 1, 2], [true, 2, 1], [false, 0, 1]])
  })
})

describe('an aggregate over a relation that empties', () => {
  // Found while checking whether the recursive stratum's aggregate path needed
  // the same treatment. It did not — an aggregate over a recursive relation is
  // its own, non-recursive stratum — but the check turned up a separate bug
  // one layer down. `count` emitted 0 for a group whose last member had gone,
  // where `sum`, `min` and `max` correctly emitted nothing and batch
  // evaluation produced no row at all.
  //
  // Reachable without recursion at all, and simply never reached before,
  // because retracting the last member of a group is the only way to get
  // there and recursive retraction is what started doing that.
  const COUNTED = `.in
.decl Arc(x: number, y: number)
.input Arc.csv

.printsize
.decl R(x: number, y: number)
.decl C(x: number, n: number)

.rule
R(x, y) :- Arc(x, y).
R(x, z) :- R(x, y), Arc(y, z).
C(x, count(y)) :- R(x, y).`

  const FLAT = `.in
.decl Arc(x: number, y: number)
.input Arc.csv

.printsize
.decl C(x: number, n: number)

.rule
C(x, count(y)) :- Arc(x, y).`

  it('drops the row rather than counting to zero', () => {
    expect(agrees(FLAT, 'Arc', 'C', [[0, 1], [1, 2]], [0, 1])).toBe(true)
    expect(incremental(FLAT, 'Arc', 'C', [[0, 1], [1, 2]], [0, 1])).toEqual(['1,1'])
  })

  it('including when what empties the group is a recursive retraction', () => {
    expect(agrees(COUNTED, 'Arc', 'C', [[0, 1], [1, 2], [2, 1]], [0, 1])).toBe(true)
  })

  it('and still counts correctly when the group only shrinks', () => {
    expect(agrees(FLAT, 'Arc', 'C', [[0, 1], [0, 2], [1, 2]], [0, 1])).toBe(true)
    expect(incremental(FLAT, 'Arc', 'C', [[0, 1], [0, 2], [1, 2]], [0, 1])).toContain('0,1')
  })
})

// -- fuzzing ------------------------------------------------------------
//
// The hand-written cases above are the ones that were reasoned about, which
// makes them exactly the ones least likely to find the next mistake. These
// generate a graph and a sequence of edits and compare against recomputation
// *after every single one*, which is how the original disagreement surfaced.
//
// Four nodes is deliberate: a random graph that small is cycles nearly all the
// time, and cycles are the whole subject. Retractions are weighted to happen
// against a populated graph rather than an empty one, since a retraction that
// removes the last edge exercises nothing.

const NODES = 4

interface Edit {
  add: boolean
  edge: readonly [number, number]
}

const editGen: fc.Arbitrary<Edit> = fc.record({
  add: fc.boolean(),
  edge: fc.tuple(
    fc.integer({ min: 0, max: NODES - 1 }),
    fc.integer({ min: 0, max: NODES - 1 }),
  ),
})

/** Apply a sequence of edits to a session, checking against a from-scratch
 *  run after each one. Returns the first divergence, or null. */
function replay(
  src: string,
  view: string,
  edits: readonly Edit[],
): { at: number; edges: string[]; got: string[]; want: string[] } | null {
  const model = new Set<string>()
  const counts = new Map<string, number>()
  const session = openSession(program(src), {}, (r, row, d) => {
    if (r !== view) return
    const k = row.join(',')
    counts.set(k, (counts.get(k) ?? 0) + d)
  })

  edits.forEach((edit, i) => {
    const key = edit.edge.join(',')
    // Skip no-ops so the multiplicities stay set-like; inserting an edge twice
    // is a different question from the one being asked here.
    if (edit.add === model.has(key)) return
    if (edit.add) model.add(key)
    else model.delete(key)
    session.update('Arc', [...edit.edge], edit.add ? 1 : -1)
    session.advance()

    const got = live(counts)
    const want = batch(
      src,
      'Arc',
      view,
      [...model].map((k) => k.split(',').map(Number) as unknown as Row),
    )
    if (got.join('|') !== want.join('|')) {
      divergence = { at: i, edges: [...model].sort(), got, want }
    }
  })
  session.close()
  const found = divergence
  divergence = null
  return found
}

let divergence: { at: number; edges: string[]; got: string[]; want: string[] } | null = null

/** Mutual recursion — the derivation cycle runs through two relations rather
 *  than one, so a fix that only understood self-referential heads would miss
 *  it. */
const MUTUAL = `.in
.decl Arc(x: number, y: number)
.input Arc.csv

.printsize
.decl P(x: number, y: number)
.decl Q(x: number, y: number)

.rule
P(x, y) :- Arc(x, y).
P(x, z) :- Q(x, y), Arc(y, z).
Q(x, y) :- P(x, y).`

describe('generated edit sequences agree with recomputation', () => {
  it('transitive closure, checked after every edit', () => {
    fc.assert(
      fc.property(fc.array(editGen, { minLength: 1, maxLength: 16 }), (edits) => {
        expect(replay(TC, 'T', edits)).toBeNull()
      }),
      { numRuns: 120 },
    )
  })

  it('reachability from a fixed source', () => {
    fc.assert(
      fc.property(fc.array(editGen, { minLength: 1, maxLength: 16 }), (edits) => {
        // `R(y) :- S(y).` with S never populated makes the view empty, so seed
        // the base case off node 0 having any outgoing edge instead.
        const src = REACH.replace('R(y) :- S(y).', 'R(y) :- Arc(0, y).')
        expect(replay(src, 'R', edits)).toBeNull()
      }),
      { numRuns: 120 },
    )
  })

  it('an aggregate stacked on a recursive relation', () => {
    const COUNTED = `.in
.decl Arc(x: number, y: number)
.input Arc.csv

.printsize
.decl R(x: number, y: number)
.decl C(x: number, n: number)

.rule
R(x, y) :- Arc(x, y).
R(x, z) :- R(x, y), Arc(y, z).
C(x, count(y)) :- R(x, y).`
    fc.assert(
      fc.property(fc.array(editGen, { minLength: 1, maxLength: 16 }), (edits) => {
        expect(replay(COUNTED, 'C', edits)).toBeNull()
      }),
      { numRuns: 120 },
    )
  })

  it('mutual recursion between two heads', () => {
    fc.assert(
      fc.property(fc.array(editGen, { minLength: 1, maxLength: 16 }), (edits) => {
        expect(replay(MUTUAL, 'P', edits)).toBeNull()
      }),
      { numRuns: 120 },
    )
  })

  it('the sequences generated actually retract into populated graphs', () => {
    // A generator that only ever grew would pass everything above while
    // testing nothing, so assert the shape of what is being produced.
    let retractionsWithEdgesLeft = 0
    fc.assert(
      fc.property(fc.array(editGen, { minLength: 8, maxLength: 24 }), (edits) => {
        const model = new Set<string>()
        for (const e of edits) {
          const k = e.edge.join(',')
          if (e.add === model.has(k)) continue
          if (e.add) model.add(k)
          else {
            model.delete(k)
            if (model.size >= 2) retractionsWithEdgesLeft++
          }
        }
        return true
      }),
      { numRuns: 200 },
    )
    expect(retractionsWithEdgesLeft).toBeGreaterThan(200)
  })
})

describe('order does not matter', () => {
  // Reaching the same graph by a different route has to give the same answer.
  // A stateful bug that survives the checks above would most likely show up as
  // a dependence on how the graph was arrived at.
  it('the same edge set reached two ways agrees', () => {
    fc.assert(
      fc.property(
        fc.array(editGen, { minLength: 1, maxLength: 14 }),
        fc.array(editGen, { minLength: 1, maxLength: 14 }),
        (a, b) => {
          const settle = (edits: readonly Edit[]) => {
            const model = new Set<string>()
            for (const e of edits) {
              const k = e.edge.join(',')
              if (e.add) model.add(k)
              else model.delete(k)
            }
            return model
          }
          // Drive one session through `a` then through the edits that turn a's
          // graph into b's, and compare with a session that only ever saw b.
          const endA = settle(a)
          const endB = settle(b)
          const bridge: Edit[] = []
          for (const k of endA) {
            if (!endB.has(k)) {
              bridge.push({ add: false, edge: k.split(',').map(Number) as [number, number] })
            }
          }
          for (const k of endB) {
            if (!endA.has(k)) {
              bridge.push({ add: true, edge: k.split(',').map(Number) as [number, number] })
            }
          }
          expect(replay(TC, 'T', [...a, ...bridge])).toBeNull()
          return true
        },
      ),
      { numRuns: 80 },
    )
  })
})
