// Where incremental retraction stops agreeing with recomputation.
//
// Found by the model-based session tests, which compare a maintained graph
// against a from-scratch run after every operation. The failing step involved
// no shadow rules at all — just `update(rel, row, -1)` — so it is an engine
// property, and worth pinning where it holds and where it doesn't.
//
// It holds for everything one would reach for: projections, joins, negation,
// linear recursion, transitive closure, and transitive closure over *cyclic*
// graphs. The one shape that breaks is a rule whose head is syntactically
// identical to its own recursive body atom:
//
//   I(s) :- I(s), E(t, s).
//
// Such a rule adds nothing to the least fixpoint — it can only re-derive what
// is already there — but incrementally it makes a tuple its own support, and
// db-ivm is d2ts with the time machinery removed, so nothing distinguishes a
// self-supporting cycle from a well-founded derivation. Fixing it needs either
// timestamps back or support counting (DRed); both are engine-shaped changes
// well beyond a bug fix, and the tradeoff was deliberate.
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

  it('for transitive closure over a cyclic graph', () => {
    // Cycles in the *data* are fine. The problem is cycles in the derivation.
    expect(agrees(TC, 'Arc', 'T', [[1, 2], [2, 1]], [2, 1])).toBe(true)
  })

  it('for a longer chain, retracting in the middle', () => {
    expect(agrees(TC, 'Arc', 'T', [[1, 2], [2, 3], [3, 4]], [2, 3])).toBe(true)
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
