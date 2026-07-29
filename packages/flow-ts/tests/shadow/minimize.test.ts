// Cutting less than the whole support set.
//
// The shadow fixpoint of a recursive rule computes *support*: every source
// tuple participating in any derivation of the target. Deleting all of it
// certainly severs the target, and that is what made the completeness property
// hold — but it is wildly over-aggressive. Removing one arc from a path is
// usually enough; removing every arc on every path is not what anyone meant by
// "delete this row".
//
// A globally *minimum* cut is a combinatorial problem. What is cheap, and what
// this does, is an **irreducible** cut: start from a set known to work and drop
// changes one at a time, keeping each drop that still achieves the request. The
// result has no redundant member — removing any single change brings the target
// back — which is a property you can actually check, and this file checks it.
//
// It is not recursion-specific. A union or a join can over-collect the same way.

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parseProgram } from '@flow-ts/parsing'
import type { Row } from '../../src/reading/index.js'
import { openBackwardSession, resolveBackward } from '../../src/shadow/index.js'
import { type Facts, key, liveRows } from './_harness.js'

const PARSE = { parse: (src: string) => parseProgram(src, { grammarSource: 's.dl' }), views: 'all' as const }

const PATH_SRC = `\
.in
.decl Arc(x: number, y: number)
.input Arc.csv

.printsize
.decl Path(x: number, y: number)

.rule
Path(x, y) :- Arc(x, y).
Path(x, z) :- Path(x, y), Arc(y, z).
`
const PATH = parseProgram(PATH_SRC, { grammarSource: 'p.dl' })

/** A single chain 0→1→2→3: every arc is load-bearing. */
const CHAIN: Facts = { Arc: [[0, 1], [1, 2], [2, 3]] }
/** Two disjoint routes from 0 to 3, so a cut needs one arc from each. */
const DIAMOND: Facts = {
  Arc: [[0, 1], [1, 3], [0, 2], [2, 3]],
}

const applyDeletes = (facts: Facts, changes: ReadonlyArray<{ rel: string; row: Row }>): Facts => {
  const drop = new Set(changes.map((c) => `${c.rel}|${key(c.row)}`))
  const out: Facts = {}
  for (const [rel, rows] of Object.entries(facts)) {
    out[rel] = rows.filter((r) => !drop.has(`${rel}|${key(r)}`))
  }
  return out
}

describe('without minimisation', () => {
  it('takes the whole support set', () => {
    const r = resolveBackward(PATH, DIAMOND, { rel: 'Path', row: [0, 3] }, PARSE)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    // All four arcs support Path(0,3) one way or another.
    expect(r.changes).toHaveLength(4)
  })
})

describe('with minimisation', () => {
  it('a chain needs exactly one arc removed', () => {
    const r = resolveBackward(PATH, CHAIN, { rel: 'Path', row: [0, 3] }, {
      ...PARSE,
      minimize: true,
    })
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.changes).toHaveLength(1)
    expect(!liveRows(PATH_SRC, applyDeletes(CHAIN, r.changes), 'Path').has(key([0, 3]))).toBe(true)
  })

  it('a diamond needs one arc from each route', () => {
    const r = resolveBackward(PATH, DIAMOND, { rel: 'Path', row: [0, 3] }, {
      ...PARSE,
      minimize: true,
    })
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.changes).toHaveLength(2)
  })

  it('leaves collateral rows alone that the full support set would have taken', () => {
    const r = resolveBackward(PATH, CHAIN, { rel: 'Path', row: [0, 3] }, {
      ...PARSE,
      minimize: true,
    })
    if (r.status !== 'ok') return
    const after = liveRows(PATH_SRC, applyDeletes(CHAIN, r.changes), 'Path')
    // Cutting one arc leaves the paths on the other side of it standing.
    expect(after.size).toBeGreaterThan(0)
  })

  it('is a no-op when the support set was already irreducible', () => {
    const PROJECTION = parseProgram(
      `\
.in
.decl Task(p: string, s: string, t: string)
.input Task.csv

.printsize
.decl Open(p: string, t: string)

.rule
Open(p, t) :- Task(p, "open", t).
`,
      { grammarSource: 'x.dl' },
    )
    const facts: Facts = { Task: [['a.md', 'open', 'milk']] }
    const plain = resolveBackward(PROJECTION, facts, { rel: 'Open', row: ['a.md', 'milk'] }, PARSE)
    const min = resolveBackward(PROJECTION, facts, { rel: 'Open', row: ['a.md', 'milk'] }, {
      ...PARSE,
      minimize: true,
    })
    expect(plain.status).toBe('ok')
    expect(min.status).toBe('ok')
    if (plain.status !== 'ok' || min.status !== 'ok') return
    expect(min.changes).toEqual(plain.changes)
  })
})

describe('sessions minimise too', () => {
  // Over-collection isn't unique to recursion — an existence test gathers every
  // row of the witness relation, and only one candidate is load-bearing.
  const EXISTS = parseProgram(
    `\
.in
.decl A(x: number)
.input A.csv
.decl C(y: number)
.input C.csv

.printsize
.decl H(x: number)

.rule
H(x) :- A(x), C(y).
`,
    { grammarSource: 'e.dl' },
  )

  it('and leave the graph reflecting only the changes kept', () => {
    const s = openBackwardSession(EXISTS, { ...PARSE, minimize: true })
    for (const row of [[1], [2]] as Row[]) s.update('A', row, 1)
    for (const row of [[7], [8], [9]] as Row[]) s.update('C', row, 1)
    s.advance()

    const r = s.resolve({ rel: 'H', row: [1] })
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    // Dropping A(1) is enough; the full support set would take all of C too.
    expect(r.changes).toEqual([{ kind: 'del', rel: 'A', row: [1] }])
    expect(s.rows('C')).toHaveLength(3)
    expect(s.rows('H').some((h) => h[0] === 1)).toBe(false)
    // …and H(2) survives, which taking all of C would have destroyed.
    expect(s.rows('H').some((h) => h[0] === 2)).toBe(true)
    s.close()
  })

  it('and over a recursive program, which it used to refuse outright', () => {
    // Minimisation is the hardest thing to ask of a session over recursion: it
    // applies a candidate, asks whether the target survived, and reverts —
    // repeatedly. Every one of those reverts is a retraction into a recursive
    // stratum, which is precisely what used to leave residue.
    const facts: Facts = { Arc: [[0, 1], [1, 2], [2, 1]] }
    const session = openBackwardSession(PATH, { ...PARSE, minimize: true })
    for (const row of facts.Arc!) session.update('Arc', row, 1)
    session.advance()

    const before = session.rows('Path').map((r) => r.join(',')).sort()
    const r = session.resolve({ rel: 'Path', row: [0, 2] })
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    // One arc, not the whole support set. Which arc is not pinned: the result
    // is irreducible rather than minimum, and cutting 0→1 or 1→2 both work.
    expect(r.changes).toHaveLength(1)
    expect(r.changes[0]!.kind).toBe('del')
    expect(r.changes[0]!.rel).toBe('Arc')

    // And the session moved to exactly where recomputation says it should be —
    // which is the part that used to fail, since every revert during the search
    // was a retraction into a recursive stratum.
    const cut = r.changes[0]!.row.join(',')
    const remaining = facts.Arc!.filter((a) => a.join(',') !== cut)
    const after = session.rows('Path').map((r2) => r2.join(',')).sort()
    expect(after).toEqual(
      [...liveRows(PATH_SRC, { Arc: remaining }, 'Path').values()]
        .map((r2) => r2.join(','))
        .sort(),
    )
    expect(after).not.toContain('0,2')
    expect(before).not.toEqual(after)
    session.close()
  })

  it('but still refuses a recursive atom that is only a guard', () => {
    // The one shape left — see strata/guard-recursion.ts. `s` appears nowhere
    // but the recursive atom, so its derivations collapse into one before any
    // of this can count them.
    const GUARD = parseProgram(
      `\
.in
.decl E(x: number)
.input E.csv

.printsize
.decl G(x: number)

.rule
G(x) :- E(x).
G(t) :- G(s), E(t).
`,
      { grammarSource: 'g.dl' },
    )
    expect(() => openBackwardSession(GUARD, { ...PARSE, minimize: true })).toThrow(
      /shares no variable with its head/i,
    )
  })
})

describe('properties', () => {
  const graphs = fc
    .uniqueArray(
      fc.tuple(fc.integer({ min: 0, max: 4 }), fc.integer({ min: 0, max: 4 })),
      { minLength: 1, maxLength: 10, selector: (e) => e.join(',') },
    )
    .map((edges) => ({ Arc: edges.map((e) => [...e] as Row) }) as Facts)

  it('the result achieves the request and has no redundant member', () => {
    let exercised = 0
    let shrunk = 0
    fc.assert(
      fc.property(graphs, fc.nat(), (facts, pick) => {
        const view = [...liveRows(PATH_SRC, facts, 'Path').values()]
        if (view.length === 0) return true
        const target = view[pick % view.length]!

        const full = resolveBackward(PATH, facts, { rel: 'Path', row: target }, PARSE)
        const min = resolveBackward(PATH, facts, { rel: 'Path', row: target }, {
          ...PARSE,
          minimize: true,
        })
        if (full.status !== 'ok' || min.status !== 'ok') return true
        exercised++
        if (min.changes.length < full.changes.length) shrunk++

        // Still achieves the request.
        const after = liveRows(PATH_SRC, applyDeletes(facts, min.changes), 'Path')
        if (after.has(key(target))) return false

        // Irreducible: putting any single change back brings the target back.
        for (const c of min.changes) {
          const without = min.changes.filter((x) => x !== c)
          const partial = liveRows(PATH_SRC, applyDeletes(facts, without), 'Path')
          if (!partial.has(key(target))) return false
        }
        return true
      }),
      { numRuns: 150 },
    )
    expect(exercised).toBeGreaterThan(40)
    // Non-vacuity: minimisation must actually be doing something.
    expect(shrunk).toBeGreaterThan(5)
  })
})
