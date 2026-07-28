// Where incremental retraction stops agreeing with recomputation.
//
// Found by the model-based session tests, which compare a maintained graph
// against a from-scratch run after every operation. The failing step involved
// no shadow rules at all — just `update(rel, row, -1)` — so it is an engine
// property, and worth pinning where it holds and where it doesn't.
//
// It holds exactly for anything without recursion — projections, joins,
// negation — which is where Z-set retraction is the whole point and does the
// whole job. Within recursion it holds for linear recursion and for transitive
// closure over an acyclic graph.
//
// What breaks is narrower than "recursion" and wider than this file used to
// claim. The condition is a *derivation* cycle that survives the retraction:
// after the fact goes, some set of derived tuples is still deriving each other,
// with nothing underneath. Plain transitive closure does it —
//
//   Arc(0,1), Arc(1,2), Arc(2,1);  retract Arc(0,1)
//
// leaves T(0,1) and T(0,2) supporting each other round the 1⇄2 loop, and both
// stay. db-ivm is d2ts with the time machinery removed, so nothing
// distinguishes that from a well-founded derivation.
//
// It is data-dependent, which is the part that matters for callers: the same
// program, the same rule, a different graph, and it is fine. That is why
// `openBackwardSession` refuses any recursive stratum outright rather than
// inspecting the facts — you cannot know in advance, so the only sound static
// answer is no.
//
// It is also not a law. Differential Dataflow gets this right with nested
// iteration timestamps, and DBSP with a properly incrementalised `distinct`
// inside the fixpoint; DRed gets it with support counting. All three are
// engine-shaped changes, and removing the timestamps was a deliberate trade.
//
// Batch evaluation is unaffected: `executeProgram` gets it right, because it
// computes the fixpoint from nothing every time.

import { describe, expect, it } from 'vitest'
import { parseProgram } from '@flow-ts/parsing'
import { executeProgram, openSession } from '../../src/executing/index.js'
import type { Row } from '../../src/reading/index.js'

const live = (c: Map<string, number>): string[] =>
  [...c.entries()].filter(([, n]) => n > 0).map(([k]) => k).sort()

function batch(src: string, edb: string, view: string, rows: Row[]): string[] {
  const c = new Map<string, number>()
  executeProgram(
    parseProgram(src, { grammarSource: 'r.dl' }),
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
  const s = openSession(parseProgram(src, { grammarSource: 'r.dl' }), {}, (r, row, d) => {
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
    // They are not — see below. Whether a retraction is sound depends on which
    // fact it is, not on the shape of the rule.
    expect(agrees(TC, 'Arc', 'T', [[1, 2], [2, 1]], [2, 1])).toBe(true)
  })

  it('for a longer chain, retracting in the middle', () => {
    expect(agrees(TC, 'Arc', 'T', [[1, 2], [2, 3], [3, 4]], [2, 3])).toBe(true)
  })
})

describe('known limit: a derivation cycle that survives the retraction', () => {
  // The case above passes; this one does not, and it is the same two rules.
  // Arc(0,1), Arc(1,2), Arc(2,1): T(0,1) derives T(0,2) via Arc(1,2), and
  // T(0,2) derives T(0,1) back via Arc(2,1). Retracting the only thing holding
  // that pair up leaves them holding each other.
  it.fails('plain transitive closure, retracting into a cycle', () => {
    expect(agrees(TC, 'Arc', 'T', [[0, 1], [1, 2], [2, 1]], [0, 1])).toBe(true)
  })

  it('and batch evaluation is right, so the rules mean what they should', () => {
    expect(batch(TC, 'Arc', 'T', [[1, 2], [2, 1]])).toEqual(
      batch(TC, 'Arc', 'T', [[0, 1], [1, 2], [2, 1]]).filter((k) => !k.startsWith('0,')),
    )
  })

  it('retracting the same graph elsewhere is sound, which is why it is refused statically', () => {
    // Nothing about the program says which of these it will be.
    expect(agrees(TC, 'Arc', 'T', [[0, 1], [1, 2], [2, 1]], [1, 2])).toBe(true)
    expect(agrees(TC, 'Arc', 'T', [[0, 1], [1, 2], [2, 1]], [2, 1])).toBe(true)
  })
})

describe('known limit: a rule that is its own support', () => {
  it('batch evaluation is right, so the rule means what it should', () => {
    // With only E(2,1), nothing derives I(1): rule 2 needs I(1) already.
    expect(batch(SELF, 'E', 'I', [[2, 1]])).toEqual(['2'])
    expect(batch(SELF, 'E', 'I', [[1, 1], [2, 1]])).toEqual(['1', '2'])
  })

  it.fails('but retracting leaves the self-supporting tuple standing', () => {
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
  // Pinned here rather than fixed because fixing it is the engine change this
  // file is about. What it does mean is that the forward store and
  // `openBackwardSession` disagree about how careful to be: the session refuses
  // a recursive program outright, and the store maintains one happily.
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
      const s = openSession(parseProgram(REACHABLE, { grammarSource: 'f.dl' }), {}, (r, row, d) => {
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

  it.fails('unfriending someone who leads to a mutual friendship', () => {
    // 1 → 2, and 2 ⇄ 3. Cutting 1 → 2 should empty the list.
    const r = unfriend([[1, 2], [2, 3], [3, 2]], [1, 2])
    expect(r.incremental).toEqual(r.batch)
  })

  it('names what the wrong answer looks like, so the shape is on the record', () => {
    const r = unfriend([[1, 2], [2, 3], [3, 2]], [1, 2])
    expect(r.batch).toEqual([])
    // Both stay reachable forever, deriving each other round the 2 ⇄ 3 loop.
    expect(r.incremental).toEqual(['2', '3'])
  })

  it('and a one-directional chain retracts correctly, as most data does', () => {
    const r = unfriend([[1, 2], [2, 3]], [1, 2])
    expect(r.incremental).toEqual(r.batch)
    expect(r.batch).toEqual([])
  })
})
