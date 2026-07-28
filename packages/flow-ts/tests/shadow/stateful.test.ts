// Model-based testing of the session.
//
// Every property so far tests one operation against a fresh graph. But the
// session is the most stateful thing here — it seeds and un-seeds, speculates
// and rolls back, minimises by applying and reverting candidates — and none of
// that is exercised across a *sequence*. A residue left by one request, or an
// incomplete rollback, would pass every one-shot test and corrupt the next one.
//
// The model is the obvious one: a maintained graph should always agree with a
// from-scratch run over the same facts. So after every operation — EDB churn,
// a delete, a rewrite, an insert, a proposal that should change nothing — every
// relation the session reports is compared against `executeProgram` on the
// session's own mirror of the EDB. Disagreement means the incremental state has
// drifted from what the program actually means.
//
// The operations are generated as indices rather than values, and interpreted
// against whatever state exists when they run. Pre-generating rows would mostly
// produce requests for things that aren't there.

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parseProgram } from '@flow-ts/parsing'
import { executeProgram } from '../../src/executing/index.js'
import type { Row } from '../../src/reading/index.js'
import { type BackwardSession, openBackwardSession } from '../../src/shadow/index.js'
import { Strata } from '../../src/strata/index.js'
import { dedupe, key } from './_harness.js'
import { type GenProgram, programGen, recursiveProgramGen } from './_gen.js'

const PARSE = { parse: (src: string) => parseProgram(src, { grammarSource: 's.dl' }), views: 'all' as const }

type Op =
  | { kind: 'addFact'; rel: number; row: number }
  | { kind: 'dropFact'; rel: number; row: number }
  | { kind: 'delete'; view: number; row: number }
  | { kind: 'update'; view: number; row: number; col: number }
  | { kind: 'insert'; view: number; row: number }
  | { kind: 'propose'; view: number; row: number }

const opGen: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant('addFact' as const), rel: fc.nat(), row: fc.nat() }),
  fc.record({ kind: fc.constant('dropFact' as const), rel: fc.nat(), row: fc.nat() }),
  fc.record({ kind: fc.constant('delete' as const), view: fc.nat(), row: fc.nat() }),
  fc.record({
    kind: fc.constant('update' as const),
    view: fc.nat(),
    row: fc.nat(),
    col: fc.nat(),
  }),
  fc.record({ kind: fc.constant('insert' as const), view: fc.nat(), row: fc.nat() }),
  fc.record({ kind: fc.constant('propose' as const), view: fc.nat(), row: fc.nat() }),
)

const pick = <T>(xs: readonly T[], i: number): T | null =>
  xs.length === 0 ? null : xs[i % xs.length]!

const sorted = (rows: readonly Row[]): string[] => rows.map(key).sort()

/** Every relation, as the session currently reports it. */
function snapshot(p: GenProgram, s: BackwardSession): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const r of [...p.edbs, ...p.idbs]) out[r.name] = sorted(s.rows(r.name))
  return out
}

/** Every relation, recomputed from scratch over the session's EDB mirror. */
function recompute(p: GenProgram, s: BackwardSession): Record<string, string[]> {
  const facts = new Map<string, Row[]>()
  for (const e of p.edbs) facts.set(e.name, s.rows(e.name))
  const counts = new Map<string, Map<string, number>>()
  const rows = new Map<string, Map<string, Row>>()
  executeProgram(parseProgram(p.source, { grammarSource: 'r.dl' }), facts, {}, (rel, row, diff) => {
    const c = counts.get(rel) ?? new Map()
    const k = key(row)
    c.set(k, (c.get(k) ?? 0) + diff)
    counts.set(rel, c)
    const m = rows.get(rel) ?? new Map()
    m.set(k, [...row])
    rows.set(rel, m)
  })
  const out: Record<string, string[]> = {}
  for (const e of p.edbs) out[e.name] = sorted(s.rows(e.name))
  for (const idb of p.idbs) {
    const c = counts.get(idb.name)
    out[idb.name] = c
      ? [...c.entries()].filter(([, n]) => n > 0).map(([k]) => k).sort()
      : []
  }
  return out
}

/** A value of the right type for a column, drawn from the generator's domain. */
const cell = (t: string, i: number): Row[number] =>
  t === 'string' ? (['x', 'y', 'z'] as const)[i % 3]! : i % 3

function runSequence(p: GenProgram, ops: readonly Op[], minimize: boolean): void {
  const program = parseProgram(p.source, { grammarSource: 'g.dl' })
  const s = openBackwardSession(program, { ...PARSE, minimize })
  const facts = dedupe(p.facts)
  for (const [rel, rows] of Object.entries(facts)) for (const r of rows) s.update(rel, r, 1)
  s.advance()

  const check = (after: string) => {
    const got = snapshot(p, s)
    const want = recompute(p, s)
    for (const rel of Object.keys(want)) {
      if (got[rel]!.join('|') !== want[rel]!.join('|')) {
        throw new Error(
          `after ${after}, ${rel} drifted\n  session:   ${got[rel]!.join(' ')}\n` +
            `  recompute: ${want[rel]!.join(' ')}\n  rules:\n  ${p.rules.join('\n  ')}\n`,
        )
      }
    }
  }
  check('load')

  for (const op of ops) {
    switch (op.kind) {
      case 'addFact': {
        const rel = pick(p.edbs, op.rel)
        if (!rel) break
        s.update(rel.name, rel.cols.map((t, i) => cell(t, op.row + i)), 1)
        s.advance()
        break
      }
      case 'dropFact': {
        const rel = pick(p.edbs, op.rel)
        if (!rel) break
        const row = pick(s.rows(rel.name), op.row)
        if (!row) break
        s.update(rel.name, row, -1)
        s.advance()
        break
      }
      case 'propose': {
        const view = pick(p.idbs, op.view)
        if (!view) break
        const row = pick(s.rows(view.name), op.row)
        if (!row) break
        // A proposal must be state-neutral, which is the whole point of it.
        s.propose({ rel: view.name, row })
        break
      }
      case 'delete': {
        const view = pick(p.idbs, op.view)
        if (!view) break
        const row = pick(s.rows(view.name), op.row)
        if (!row) break
        s.resolve({ rel: view.name, row })
        break
      }
      case 'update': {
        const view = pick(p.idbs, op.view)
        if (!view) break
        const row = pick(s.rows(view.name), op.row)
        if (!row) break
        const c = op.col % row.length
        const next = [...row]
        next[c] = typeof row[c] === 'string' ? `${row[c]}~n` : (row[c] as number) + 100
        s.resolve({ rel: view.name, row, newRow: next })
        break
      }
      case 'insert': {
        const view = pick(p.idbs, op.view)
        if (!view) break
        const row = view.cols.map((t, i) => cell(t, op.row + i + 1))
        s.resolve({ rel: view.name, row, insert: true })
        break
      }
    }
    check(op.kind)
  }
  s.close()
}

describe('a session agrees with recomputation after every operation', () => {
  it('over non-recursive programs', () => {
    fc.assert(
      fc.property(programGen, fc.array(opGen, { minLength: 1, maxLength: 12 }), (p, ops) => {
        runSequence(p, ops, false)
        return true
      }),
      { numRuns: 120 },
    )
  })

  // Not over recursive programs, and the reason changed. It used to be that
  // retraction through a recursive stratum did not fully propagate, so a
  // proposal left residue for the next one. That is fixed — see
  // tests/executing/recursive-retraction.test.ts, and the pinned program below,
  // whose *executor* agrees with recomputation across two hundred fuzzed
  // retractions.
  //
  // This layer still drifts on some of them. Lifting the refusal on the
  // strength of the executor fix was tried and this test caught it, twice in
  // three seeds, which is the whole reason it exists.
  it('and refuses recursive programs outright, rather than drifting', () => {
    let refused = 0
    fc.assert(
      fc.property(recursiveProgramGen, (p) => {
        const program = parseProgram(p.source, { grammarSource: 'g.dl' })
        const strata = Strata.fromParser(program)
        if (!strata.isRecursiveStrataBitmap.some(Boolean)) return true
        refused++
        try {
          openBackwardSession(program, PARSE)
          return false
        } catch (e) {
          return /recursive stratum/i.test((e as Error).message)
        }
      }),
      { numRuns: 150 },
    )
    expect(refused).toBeGreaterThan(30)
  })

  // The counterexample, kept so the next attempt starts from a known-hard case
  // rather than waiting for a seed to rediscover it. The recursive rule takes
  // one column from itself and the other from an unrelated relation, so the
  // derived set grows by cross product rather than by following a path.
  it('the shape that drifts, so the next attempt has somewhere to start', () => {
    const source = `.in
.decl E0(c0: string)
.input E0.csv
.decl E1(c0: number, c1: string, c2: number)
.input E1.csv
.printsize
.decl I0(c0: number, c1: string)
.rule
I0(a, s) :- E1(a, s, _), E0("x"), E0(s), s < "y".
I0(a, s) :- I0(a, t), E0(s).`
    const program = parseProgram(source, { grammarSource: 'g.dl' })
    expect(Strata.fromParser(program).isRecursiveStrataBitmap.some(Boolean)).toBe(true)
    expect(() => openBackwardSession(program, PARSE)).toThrow(/recursive stratum/i)
    // With the refusal overridden it opens, and that is where the drift is.
    const session = openBackwardSession(program, { ...PARSE, allowRecursive: true })
    expect(session).toBeDefined()
    session.close()
  })

  it('with minimisation on, which applies and reverts candidates as it searches', () => {
    fc.assert(
      fc.property(programGen, fc.array(opGen, { minLength: 1, maxLength: 10 }), (p, ops) => {
        runSequence(p, ops, true)
        return true
      }),
      { numRuns: 100 },
    )
  })
})

describe('proposals never move the needle', () => {
  it('a run of proposals leaves every relation exactly as it was', () => {
    let exercised = 0
    fc.assert(
      fc.property(programGen, fc.array(fc.nat(), { minLength: 1, maxLength: 8 }), (p, picks) => {
        const program = parseProgram(p.source, { grammarSource: 'g.dl' })
        const s = openBackwardSession(program, PARSE)
        const facts = dedupe(p.facts)
        for (const [rel, rows] of Object.entries(facts)) for (const r of rows) s.update(rel, r, 1)
        s.advance()

        const before = JSON.stringify(snapshot(p, s))
        for (const i of picks) {
          const view = pick(p.idbs, i)
          if (!view) continue
          const row = pick(s.rows(view.name), i)
          if (!row) continue
          exercised++
          s.propose({ rel: view.name, row })
          s.propose({ rel: view.name, row, insert: true })
          const next = [...row]
          next[0] = typeof row[0] === 'string' ? 'zz' : 999
          s.propose({ rel: view.name, row, newRow: next })
        }
        const after = JSON.stringify(snapshot(p, s))
        s.close()
        return before === after
      }),
      { numRuns: 150 },
    )
    expect(exercised).toBeGreaterThan(50)
  })
})
