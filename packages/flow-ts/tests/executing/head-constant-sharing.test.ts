// Regression: two rules over the same body, with a constant in different head
// positions, used to collide.
//
// Found by fuzzing the shadow compiler, which emits exactly this shape — one
// shadow rule per body atom, all sharing the original body, each projecting a
// different head. A bare constant in a head contributes no *variable*, so both
//
//   P(0, b) :- A(b).
//   Q(b, 0) :- A(b).
//
// reduce to the same intermediate collection (`b`), and the head-arithmetic
// post-map that reconstructs the real head was named after its input alone.
// Same name meant one shared post-map, so one rule's projections were applied
// to both. `--no-sharing` didn't help; it only changed which rule won.
//
// The two-rules-one-relation case was worse: a row went missing entirely.

import { describe, expect, it } from 'vitest'
import { parseProgram } from '../../src/parsing/index.js'
import { executeProgram } from '../../src/executing/index.js'
import type { Row } from '../../src/reading/index.js'

function run(source: string, facts: Record<string, Row[]>, noSharing = false): Set<string> {
  const out = new Set<string>()
  executeProgram(
    parseProgram(source, { grammarSource: 'hc.dl' }),
    new Map(Object.entries(facts)),
    { noSharing },
    (rel, row, diff) => {
      if (diff > 0) out.add(`${rel}(${row.join(',')})`)
    },
  )
  return out
}

/** Both sharing modes must agree with the expectation. */
function bothModes(source: string, facts: Record<string, Row[]>, expected: string[]) {
  expect(run(source, facts, false)).toEqual(new Set(expected))
  expect(run(source, facts, true)).toEqual(new Set(expected))
}

describe('head constants with identical bodies', () => {
  it('two relations, constant at opposite ends', () => {
    bothModes(
      `.in
.decl A(x: number)
.input A.csv

.printsize
.decl P(c0: number, c1: number)
.decl Q(c0: number, c1: number)

.rule
P(0, b) :- A(b).
Q(b, 0) :- A(b).`,
      { A: [[1]] },
      ['P(0,1)', 'Q(1,0)'],
    )
  })

  it('one relation, two rules — neither row may be lost', () => {
    bothModes(
      `.in
.decl A(x: number)
.input A.csv

.printsize
.decl P(c0: number, c1: number)

.rule
P(0, b) :- A(b).
P(b, 0) :- A(b).`,
      { A: [[1]] },
      ['P(0,1)', 'P(1,0)'],
    )
  })

  it('distinct constants in the same position', () => {
    bothModes(
      `.in
.decl A(x: number)
.input A.csv

.printsize
.decl P(c0: number, c1: number)

.rule
P(b, 7) :- A(b).
P(b, 9) :- A(b).`,
      { A: [[1]] },
      ['P(1,7)', 'P(1,9)'],
    )
  })

  it('head arithmetic, not just constants', () => {
    bothModes(
      `.in
.decl A(x: number)
.input A.csv

.printsize
.decl P(c0: number)
.decl Q(c0: number)

.rule
P(b + 1) :- A(b).
Q(b + 2) :- A(b).`,
      { A: [[10]] },
      ['P(11)', 'Q(12)'],
    )
  })

  it('string constants too', () => {
    bothModes(
      `.in
.decl A(x: number)
.input A.csv

.printsize
.decl P(c0: string, c1: number)
.decl Q(c0: number, c1: string)

.rule
P("k", b) :- A(b).
Q(b, "k") :- A(b).`,
      { A: [[1]] },
      ['P(k,1)', 'Q(1,k)'],
    )
  })

  it('control: no constants, so no post-map to collide', () => {
    bothModes(
      `.in
.decl A(x: number, y: number)
.input A.csv

.printsize
.decl P(c0: number, c1: number)
.decl Q(c0: number, c1: number)

.rule
P(x, y) :- A(x, y).
Q(y, x) :- A(x, y).`,
      { A: [[1, 2]] },
      ['P(1,2)', 'Q(2,1)'],
    )
  })
})
