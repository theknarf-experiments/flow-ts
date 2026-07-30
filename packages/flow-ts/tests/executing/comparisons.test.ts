// Where computed values may appear, and what a body comparison actually is.
//
// These are load-bearing facts for anything that generates Datalog (the shadow
// compiler in particular), and none of them were pinned anywhere:
//
//   • A body comparison is a *filter* over already-bound variables. It cannot
//     introduce one. `S(y) :- R(x), y = x + 1.` looks like an assignment and
//     is not — the planner rejects it.
//   • Computing a value is done in the *head*: `S(x + 1) :- R(x).`
//   • Arithmetic is flat (no parentheses) and left-to-right with no operator
//     precedence, so `10 - 1 * n` is `(10 - 1) * n`.
//   • Division truncates toward zero; there is no true division.
//
// Together these mean a generator has to thread multi-step expressions through
// helper relations, one operation per rule, and cannot produce a fractional
// value at all.

import { describe, expect, it } from 'vitest'
import { parseProgram } from '../../src/parsing/index.js'
import { executeProgram } from '../../src/executing/index.js'
import type { Row } from '../../src/reading/index.js'

function run(source: string, facts: Record<string, Row[]>): Set<string> {
  const out = new Set<string>()
  executeProgram(
    parseProgram(source, { grammarSource: 'cmp.dl' }),
    new Map(Object.entries(facts)),
    {},
    (rel, row, diff) => {
      if (diff > 0) out.add(`${rel}(${row.join(', ')})`)
    },
  )
  return out
}

const UNARY = `.in
.decl R(x: number)
.input R.csv

.printsize
.decl S(y: number)

.rule
`

describe('body comparisons are filters, not bindings', () => {
  it('a comparison over a bound variable filters', () => {
    expect(run(`${UNARY}S(x) :- R(x), x < 2.`, { R: [[1], [2], [3]] })).toEqual(new Set(['S(1)']))
  })

  it('an equality over a bound variable also filters', () => {
    expect(run(`${UNARY}S(x) :- R(x), x = 2.`, { R: [[1], [2], [3]] })).toEqual(new Set(['S(2)']))
  })

  it('a comparison cannot introduce a new variable', () => {
    expect(() => run(`${UNARY}S(y) :- R(x), y = x + 1.`, { R: [[1]] })).toThrow()
  })
})

describe('computed values live in the head', () => {
  it('head arithmetic computes', () => {
    expect(run(`${UNARY}S(x + 1) :- R(x).`, { R: [[1], [2]] })).toEqual(
      new Set(['S(2)', 'S(3)']),
    )
  })

  it('arithmetic has no parentheses', () => {
    expect(() => parseProgram(`${UNARY}S(x + 1 / 2) :- R(x).`)).not.toThrow()
    expect(() => parseProgram(`${UNARY}S((x + 1) / 2) :- R(x).`)).toThrow()
  })

  it('arithmetic is left-to-right, without precedence', () => {
    // With x = 10: left-to-right gives (10 - 1) * 2 = 18, not 10 - 2 = 8.
    expect(run(`${UNARY}S(x - 1 * 2) :- R(x).`, { R: [[10]] })).toEqual(new Set(['S(18)']))
  })

  it('division truncates toward zero', () => {
    expect(run(`${UNARY}S(x / 2) :- R(x).`, { R: [[1], [5], [-5]] })).toEqual(
      new Set(['S(0)', 'S(2)', 'S(-2)']),
    )
  })

  it('a float-typed column does not change that', () => {
    const src = `.in
.decl R(x: number)
.input R.csv

.printsize
.decl S(y: float)

.rule
S(x / 2) :- R(x).`
    expect(run(src, { R: [[1]] })).toEqual(new Set(['S(0)']))
  })
})
