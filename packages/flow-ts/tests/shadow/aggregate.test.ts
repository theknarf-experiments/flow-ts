// Is the least-change inverse of a linear aggregate expressible as Datalog?
//
// bireactive's `mean` distributes a write by adding one shared delta to every
// input (src/core/lenses/aggregates.ts:42), and `mix` says outright that it
// writes "the minimum-norm delta" — the pseudoinverse. That isn't a policy
// choice: over the reals, minimising Σδᵢ² subject to Σδᵢ = Δ gives δᵢ = Δ/n
// uniquely. So for a linear aggregate the inverse looked *determined*, and the
// only question was whether flow-ts could express it.
//
// It can't, quite, and the reason is interesting. Three constraints in the
// language shape the answer:
//
//   1. A computed value must appear in the *head*. Body comparisons are
//      filters over already-bound variables and cannot introduce one, so
//      `Delta(p, d) :- Req(p, s2), Total(p, s), d = s2 - s.` is rejected.
//   2. Arithmetic is flat (no parentheses) and left-to-right with no
//      precedence, so `d - q * n` means `(d - q) * n`.
//   3. `Divide` is `Math.trunc(acc / x)` — integer division. There is no
//      true division in the language at all.
//
// tests/executing/comparisons.test.ts pins all three.
//
// (1) and (2) are only inconvenient: one operation per rule, threaded through
// helper relations, expresses any expression. (3) is substantive. Over the
// integers `Δ/n` is not representable when `n ∤ Δ`, so equal-split does not
// round-trip — and integer least-change is *genuinely ambiguous*: give
// `⌊Δ/n⌋` to everyone and one extra unit to `Δ mod n` of the members, and
// every choice of *which* members is equally minimal.
//
// So the honest conclusion is the opposite of what I expected. `sum` needs no
// annotation for its *shape* — the distribution is forced — but it does need
// one for the residual: who absorbs the remainder. That is a real policy, and
// it is the smallest possible one.

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parseProgram } from '../../src/parsing/index.js'
import { executeProgram } from '../../src/executing/index.js'
import type { Row } from '../../src/reading/index.js'

function run(source: string, facts: Record<string, Row[]>): Map<string, Row[]> {
  const counts = new Map<string, Map<string, { row: Row; n: number }>>()
  executeProgram(
    parseProgram(source, { grammarSource: 'agg.dl' }),
    new Map(Object.entries(facts)),
    {},
    (rel, row, diff) => {
      const m = counts.get(rel) ?? new Map()
      const k = row.join('')
      const cur = m.get(k)
      m.set(k, { row: [...row], n: (cur?.n ?? 0) + diff })
      counts.set(rel, m)
    },
  )
  const out = new Map<string, Row[]>()
  for (const [rel, m] of counts) {
    const rows = [...m.values()].filter((e) => e.n > 0).map((e) => e.row)
    if (rows.length > 0) out.set(rel, rows)
  }
  return out
}

const byRow = (rows: Row[] | undefined): Row[] =>
  [...(rows ?? [])].sort((a, b) => String(a).localeCompare(String(b)))

const DECLS = `\
.in
.decl Hours(p: string, w: number, h: number)
.input Hours.csv
.decl Req(p: string, s2: number)
.input Req.csv

.printsize
.decl Total(p: string, s: number)
.decl Size(p: string, n: number)
.decl Delta(p: string, d: number)
.decl Share(p: string, q: number)
.decl NewHours(p: string, w: number, h2: number)
`

// Naive equal split. One operation per rule, because arithmetic is flat.
const EQUAL_SPLIT = `${DECLS}
.rule
Total(p, sum(h)) :- Hours(p, w, h).
Size(p, count(w)) :- Hours(p, w, h).
Delta(p, s2 - s) :- Req(p, s2), Total(p, s).
Share(p, d / n) :- Delta(p, d), Size(p, n).
NewHours(p, w, h + q) :- Hours(p, w, h), Share(p, q).
`

// Equal split plus a residual, so the proposal round-trips for every delta.
// The absorber is the group's lowest member id — an arbitrary but *stated*
// choice, which is exactly the annotation this case needs.
const WITH_RESIDUAL = `${DECLS}.decl Prod(p: string, m: number)
.decl Rem(p: string, r: number)
.decl Absorber(p: string, w: number)

.rule
Total(p, sum(h)) :- Hours(p, w, h).
Size(p, count(w)) :- Hours(p, w, h).
Delta(p, s2 - s) :- Req(p, s2), Total(p, s).
Share(p, d / n) :- Delta(p, d), Size(p, n).
Prod(p, q * n) :- Share(p, q), Size(p, n).
Rem(p, d - m) :- Delta(p, d), Prod(p, m).
Absorber(p, min(w)) :- Hours(p, w, h).
NewHours(p, w, h + q) :- Hours(p, w, h), Share(p, q), Absorber(p, a), w != a.
NewHours(p, w, h + q + r) :- Hours(p, w, h), Share(p, q), Rem(p, r), Absorber(p, w).
`

describe('language constraints the compiler has to work around', () => {
  it('arithmetic has no parentheses', () => {
    expect(() =>
      parseProgram(`${DECLS}\n.rule\nShare(p, q) :- Delta(p, d), Size(p, n), q = (d - 1) / n.`, {
        grammarSource: 'x.dl',
      }),
    ).toThrow()
  })

  it('a body equality cannot introduce the computed value', () => {
    // Which is why every helper relation below puts its arithmetic in the head.
    const asBodyEquality = EQUAL_SPLIT.replace(
      'Delta(p, s2 - s) :- Req(p, s2), Total(p, s).',
      'Delta(p, d) :- Req(p, s2), Total(p, s), d = s2 - s.',
    )
    expect(() => run(asBodyEquality, { Hours: [['x', 1, 0]], Req: [['x', 1]] })).toThrow()
  })

  it('division truncates — there is no true division', () => {
    const out = run(EQUAL_SPLIT, {
      Hours: [['x', 1, 0], ['x', 2, 0]],
      Req: [['x', 1]], // Δ=1 over 2 members
    })
    // The real least-change share is +0.5 each. Integer division gives 0.
    expect(out.get('Share')).toEqual([['x', 0]])
  })
})

describe('equal split: correct exactly when n divides the delta', () => {
  it('round-trips when the delta divides evenly', () => {
    const out = run(EQUAL_SPLIT, {
      Hours: [['x', 1, 2], ['x', 2, 4]],
      Req: [['x', 10]], // Δ=4 over 2 = +2 each
    })
    expect(byRow(out.get('NewHours'))).toEqual([
      ['x', 1, 4],
      ['x', 2, 6],
    ])
    const after = run(EQUAL_SPLIT, { Hours: out.get('NewHours')!, Req: [] })
    expect(after.get('Total')).toEqual([['x', 10]])
  })

  it('silently under-delivers when it does not', () => {
    const out = run(EQUAL_SPLIT, {
      Hours: [['x', 1, 0], ['x', 2, 0]],
      Req: [['x', 1]],
    })
    const after = run(EQUAL_SPLIT, { Hours: out.get('NewHours')!, Req: [] })
    // Requested 1, achieved 0 — sound but not complete. This is the failure a
    // round-trip check at runtime is there to catch.
    expect(after.get('Total')).toEqual([['x', 0]])
  })
})

describe('equal split + residual: round-trips for every delta', () => {
  const HOURS: Row[] = [
    ['x', 1, 5],
    ['x', 2, 7],
    ['x', 3, 11],
  ]

  it('names the absorber and gives it the remainder', () => {
    const out = run(WITH_RESIDUAL, { Hours: HOURS, Req: [['x', 27]] })
    // Total 23 → 27, Δ=4 over 3: q=1, remainder 1 to member 1.
    expect(out.get('Absorber')).toEqual([['x', 1]])
    expect(byRow(out.get('NewHours'))).toEqual([
      ['x', 1, 7],
      ['x', 2, 8],
      ['x', 3, 12],
    ])
  })

  it.each([0, 1, 2, 3, 4, 5, 7, 11, -1, -2, -4, -23, -30])(
    'achieves the requested total exactly (target %i)',
    (target) => {
      const out = run(WITH_RESIDUAL, { Hours: HOURS, Req: [['x', target]] })
      const proposed = out.get('NewHours')!
      expect(proposed).toHaveLength(HOURS.length)
      const after = run(WITH_RESIDUAL, { Hours: proposed, Req: [] })
      expect(after.get('Total')).toEqual([['x', target]])
    },
  )

  it('round-trips for arbitrary groups and targets', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 9 }), fc.integer({ min: -20, max: 20 })), {
          minLength: 1,
          maxLength: 6,
        }),
        fc.integer({ min: -50, max: 50 }),
        (members, target) => {
          // Distinct member ids: the group is a set, and two rows with the same
          // id would be one member as far as `count` is concerned.
          const seen = new Map<number, number>()
          for (const [w, h] of members) seen.set(w, h)
          const hours: Row[] = [...seen].map(([w, h]) => ['x', w, h])

          const out = run(WITH_RESIDUAL, { Hours: hours, Req: [['x', target]] })
          const proposed = out.get('NewHours')
          if (!proposed) return false
          if (proposed.length !== hours.length) return false

          const after = run(WITH_RESIDUAL, { Hours: proposed, Req: [] })
          const total = after.get('Total')?.[0]?.[1]
          return total === target
        },
      ),
      { numRuns: 200 },
    )
  })

  it('is least-change: shares differ by at most one unit', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -20, max: 20 }), { minLength: 1, maxLength: 6 }),
        fc.integer({ min: -50, max: 50 }),
        (hs, target) => {
          const hours: Row[] = hs.map((h, i) => ['x', i, h])
          const out = run(WITH_RESIDUAL, { Hours: hours, Req: [['x', target]] })
          const proposed = out.get('NewHours')!
          const before = new Map(hours.map((r) => [r[1] as number, r[2] as number]))
          const deltas = proposed.map((r) => (r[2] as number) - before.get(r[1] as number)!)
          // Integer least-change: every δ is ⌊Δ/n⌋ or that plus the residual,
          // so the spread across members never exceeds |Δ mod n| ≤ n-1… and for
          // the single-absorber policy, at most one member differs from the rest.
          const distinct = new Set(deltas)
          return distinct.size <= 2
        },
      ),
      { numRuns: 200 },
    )
  })

  it('leaves other groups alone', () => {
    const out = run(WITH_RESIDUAL, {
      Hours: [...HOURS, ['y', 9, 100]],
      Req: [['x', 0]],
    })
    expect(out.get('NewHours')?.some((r) => r[0] === 'y')).toBe(false)
  })
})
