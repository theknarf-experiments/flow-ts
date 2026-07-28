// Known planner gaps, found by the shadow-rule program fuzzer
// (`tests/shadow/_gen.ts`). Both are legal Datalog that the forward engine
// refuses to plan, and neither involves shadow rules — the fuzzer just reaches
// rule shapes the hand-written suites never did.
//
// These are `it.fails`, so they document the bug *and* flip loudly the moment
// someone fixes it. When that happens, drop the `.fails` and keep the
// assertion — the expected results below are what the rules actually mean.

import { describe, expect, it } from 'vitest'
import { parseProgram } from '@flow-ts/parsing'
import { executeProgram } from '../../src/executing/index.js'
import type { Row } from '../../src/reading/index.js'

function run(source: string, facts: Record<string, Row[]>): Set<string> {
  const out = new Set<string>()
  executeProgram(
    parseProgram(source, { grammarSource: 'gap.dl' }),
    new Map(Object.entries(facts)),
    {},
    (rel, row, diff) => {
      if (diff > 0) out.add(`${rel}(${row.join(', ')})`)
    },
  )
  return out
}

const E0 = (arity: number, head: string) => `\
.in
.decl E0(${Array.from({ length: arity }, (_, i) => `c${i}: number`).join(', ')})
.input E0.csv

.printsize
.decl I0(${head})

.rule
`

// GAP 1 — a body atom that shares no variable with the rest of the body (a
// cartesian factor) *and* contributes no column to the head.
//
// The planner then builds an intermediate collection with neither key columns
// (nothing to join on) nor value columns (nothing to carry), and `buildKvToKv`
// has no name for a zero-column shape. Semantically these rules are ordinary
// existence tests — "I0(a) if E0(a) holds and E0 is non-empty" — so supporting
// them means a unit/boolean collection kind through planning and execution.
//
// The boundary is sharp, and both halves matter:
//   ok     I0(a, b) :- E0(a), E0(b).      cartesian, but `b` reaches the head
//   ok     I0(a)    :- E0(a, b), E0(b, c). shares `b`, so not cartesian
//   CRASH  I0(a)    :- E0(a), E0(b).      cartesian *and* `b` is dropped
describe('planner gap: cartesian body atom with no surviving column', () => {
  it.fails('existence test via an unrelated atom', () => {
    const rows = run(`${E0(1, 'h0: number')}I0(a) :- E0(a), E0(b).`, { E0: [[1], [2]] })
    // E0 is non-empty, so every E0(a) qualifies.
    expect(rows).toEqual(new Set(['I0(1)', 'I0(2)']))
  })

  it.fails('degenerate case: an atom with no variables at all', () => {
    const rows = run(`${E0(2, 'h0: number')}I0(a) :- E0(a, a), E0(0, 0).`, {
      E0: [[1, 1], [0, 0]],
    })
    expect(rows).toEqual(new Set(['I0(1)', 'I0(0)']))
  })

  it.fails('degenerate case: an all-placeholder atom', () => {
    const rows = run(`${E0(2, 'h0: number')}I0(a) :- E0(a, a), E0(_, _).`, { E0: [[1, 1]] })
    expect(rows).toEqual(new Set(['I0(1)']))
  })

  it('control: the same cartesian atom plans when its variable reaches the head', () => {
    expect(run(`${E0(1, 'h0: number, h1: number')}I0(a, b) :- E0(a), E0(b).`, { E0: [[1], [2]] }))
      .toEqual(new Set(['I0(1, 1)', 'I0(1, 2)', 'I0(2, 1)', 'I0(2, 2)']))
  })

  it('control: a shared variable makes it a join, not a cartesian factor', () => {
    expect(run(`${E0(2, 'h0: number')}I0(a) :- E0(a, b), E0(b, c).`, { E0: [[1, 2], [2, 3]] }))
      .toEqual(new Set(['I0(1)']))
  })
})

// FIXED — was a gap, now a regression test. A constant inside a negated atom,
// combined with a comparison elsewhere in the body, used to crash: the trace
// that aligns a negated atom's arguments demanded a signature-map entry for
// every position, and a constant has no variable name so it has none. It can
// never match a trace argument either, so skipping it is the right answer.
// Either ingredient alone always planned, which is why this went unnoticed.
describe('constant in a negated atom alongside a comparison', () => {
  it('both ingredients together', () => {
    const rows = run(`${E0(2, 'h0: number')}I0(a) :- E0(a, a), !E0(0, a), a < 5.`, {
      E0: [[1, 1]],
    })
    expect(rows).toEqual(new Set(['I0(1)']))
  })

  it('control: constant in a negated atom, no comparison', () => {
    expect(run(`${E0(2, 'h0: number')}I0(a) :- E0(a, a), !E0(0, a).`, { E0: [[1, 1]] }))
      .toEqual(new Set(['I0(1)']))
  })

  it('control: comparison, but no constant in the negated atom', () => {
    expect(run(`${E0(2, 'h0: number')}I0(a) :- E0(a, a), !E0(a, 9), a < 5.`, { E0: [[1, 1]] }))
      .toEqual(new Set(['I0(1)']))
  })
})
