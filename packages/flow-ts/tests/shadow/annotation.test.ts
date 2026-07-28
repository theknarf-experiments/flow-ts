// Annotations: the semantics the compiler cannot infer.
//
// Everything the compiler generates on its own is forced by the rule. An
// aggregate isn't: its inverse needs a distribution, and over the integers
// even the *least-change* distribution leaves a residual whose owner is a free
// choice (see aggregate.test.ts). So `sum` gets exactly one knob — who absorbs
// the remainder — and nothing more.
//
// The annotation is deliberately not a hand-written inverse. It names a policy;
// the compiler still generates the rules, so the result stays checkable against
// the forward engine like everything else.

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parseProgram } from '@flow-ts/parsing'
import { compileShadow, resolveBackward } from '../../src/shadow/index.js'
import type { Row } from '../../src/reading/index.js'
import { type Facts, applyUpdates, backward, liveRows } from './_harness.js'

const SUM = `\
.in
.decl Hours(p: string, w: number, h: number)
.input Hours.csv

.printsize
.decl Total(p: string, s: number)

.rule
Total(p, sum(h)) :- Hours(p, w, h).
`

const SPREAD = { put: { Total: { kind: 'spread' as const, residual: 'min' as const } } }

describe('without an annotation', () => {
  it('refuses the aggregate and generates nothing for it', () => {
    const shadow = compileShadow(parseProgram(SUM))
    expect(shadow.refusals.some((r) => /aggregation/i.test(r.reason))).toBe(true)
    expect(shadow.source).not.toContain('Upd_Hours')
  })
})

describe('with a spread annotation', () => {
  it('stops refusing and generates the distribution', () => {
    const shadow = compileShadow(parseProgram(SUM), SPREAD)
    expect(shadow.refusals.filter((r) => /aggregation/i.test(r.reason))).toEqual([])
    expect(shadow.source).toContain('Upd_Hours(')
    // The generated program has to be readable back in, like any other.
    expect(() => parseProgram(shadow.source, { grammarSource: 's.dl' })).not.toThrow()
  })

  it('names the absorber explicitly in the generated rules', () => {
    const shadow = compileShadow(parseProgram(SUM), SPREAD)
    expect(shadow.source).toMatch(/min\(w\)/)
  })

  it('rejects a residual policy on a non-aggregate head', () => {
    const shadow = compileShadow(
      parseProgram(`\
.in
.decl R(x: number)
.input R.csv

.printsize
.decl S(y: number)

.rule
S(x) :- R(x).
`),
      { put: { S: { kind: 'spread', residual: 'min' } } },
    )
    expect(shadow.refusals.some((r) => /not an aggregate/i.test(r.reason))).toBe(true)
  })
})

describe('the annotation can live in the program source', () => {
  // `.put` on the declaration is the program stating its own intent, which is
  // what makes this usable from a vault: the policy travels with the rules
  // rather than living in the caller's code.
  const ANNOTATED = `\
.in
.decl Hours(p: string, w: number, h: number)
.input Hours.csv

.printsize
.decl Total(p: string, s: number)
.put spread(min)

.rule
Total(p, sum(h)) :- Hours(p, w, h).
`

  it('needs no options object', () => {
    const shadow = compileShadow(parseProgram(ANNOTATED))
    expect(shadow.refusals.filter((r) => /aggregation/i.test(r.reason))).toEqual([])
    expect(shadow.source).toContain('Upd_Hours(')
  })

  it('resolves a request end to end', () => {
    const r = resolveBackward(
      parseProgram(ANNOTATED),
      { Hours: [['x', 1, 5], ['x', 2, 7]] },
      { rel: 'Total', row: ['x', 12], newRow: ['x', 15] },
      { parse: (src) => parseProgram(src, { grammarSource: 'shadow.dl' }) },
    )
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    // Δ=3 over 2 members: +1 each, remainder 1 to member 1.
    expect(r.changes.map((c) => c.newRow)).toEqual(
      expect.arrayContaining([
        ['x', 1, 7],
        ['x', 2, 8],
      ]),
    )
  })

  it('an explicit .put none is a decision, not an omission', () => {
    const shadow = compileShadow(
      parseProgram(ANNOTATED.replace('.put spread(min)', '.put none')),
    )
    expect(shadow.source).not.toContain('Upd_Hours(')
    expect(shadow.refusals.filter((r) => /aggregation/i.test(r.reason))).toEqual([])
  })

  it('options override the directive', () => {
    const shadow = compileShadow(parseProgram(ANNOTATED), {
      put: { Total: { kind: 'none' } },
    })
    expect(shadow.source).not.toContain('Upd_Hours(')
  })
})

describe('behaviour', () => {
  const FACTS: Facts = {
    Hours: [
      ['x', 1, 5],
      ['x', 2, 7],
      ['x', 3, 11],
      ['y', 9, 100],
    ],
  }

  it('spreads the delta and gives the remainder to the lowest member', () => {
    const { upd } = backward(SUM, FACTS, 'Total', ['x', 23], ['x', 27], SPREAD)
    const rows = [...(upd.get('Hours')?.values() ?? [])].sort((a, b) =>
      Number(a[1]) - Number(b[1]),
    )
    // Δ=4 over 3 members: +1 each, remainder 1 to member 1.
    expect(rows).toEqual([
      ['x', 1, 5, 'x', 1, 7],
      ['x', 2, 7, 'x', 2, 8],
      ['x', 3, 11, 'x', 3, 12],
    ])
  })

  it('leaves other groups untouched', () => {
    const { upd } = backward(SUM, FACTS, 'Total', ['x', 23], ['x', 27], SPREAD)
    for (const row of upd.get('Hours')?.values() ?? []) expect(row[0]).toBe('x')
  })

  it('round-trips: the requested total is what the program then derives', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 9 }), { minLength: 1, maxLength: 5 }),
        fc.array(fc.integer({ min: -20, max: 20 }), { minLength: 5, maxLength: 5 }),
        fc.integer({ min: -40, max: 40 }),
        (members, hs, target) => {
          const hours: Row[] = members.map((w, i) => ['x', w, hs[i % hs.length]!])
          const facts: Facts = { Hours: hours }
          const before = [...liveRows(SUM, facts, 'Total').values()][0]
          if (!before) return true

          const { upd } = backward(SUM, facts, 'Total', before, ['x', target], SPREAD)
          if (!upd.get('Hours')) return false
          const after = liveRows(SUM, applyUpdates(facts, upd), 'Total')
          return [...after.values()].some((r) => r[0] === 'x' && r[1] === target)
        },
      ),
      { numRuns: 150 },
    )
  })
})
