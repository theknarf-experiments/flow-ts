// Rule shapes the shadow-rule program fuzzer (`tests/shadow/_gen.ts`) reached
// and the hand-written suites never did. All were legal Datalog the forward
// engine refused to plan; all are now fixed, and these are the regression
// tests. They were written first as `it.fails` carrying the results the rules
// actually mean, so each one flipped loudly the moment its bug was fixed —
// which is how the fixes were confirmed to be right rather than merely quiet.

import { describe, expect, it } from 'vitest'
import { parseProgram } from '../../src/parsing/index.js'
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

// An existence test: a body atom that shares no variable with the rest of the
// body (a cartesian factor) *and* contributes no column to the head. All that
// matters is whether it holds at all.
//
// The boundary is sharp, and both halves matter:
//   ok     I0(a, b) :- E0(a), E0(b).      cartesian, but `b` reaches the head
//   ok     I0(a)    :- E0(a, b), E0(b, c). shares `b`, so not cartesian
//   CRASH  I0(a)    :- E0(a), E0(b).      cartesian *and* `b` is dropped
//
// `buildKvToKv` used to throw for an output with neither key nor value columns,
// treating a legal shape as an internal invariant violation. It now builds a
// *unit* collection — the empty tuple, present iff the input is non-empty — and
// the cartesian join that already existed gates its partner on that. The dedupe
// is semantics rather than optimisation: without it a relation of N rows would
// carry multiplicity N into the join and multiply its partner N-fold.
describe('existence tests: a cartesian atom with no surviving column', () => {
  it('existence test via an unrelated atom', () => {
    const rows = run(`${E0(1, 'h0: number')}I0(a) :- E0(a), E0(b).`, { E0: [[1], [2]] })
    // E0 is non-empty, so every E0(a) qualifies.
    expect(rows).toEqual(new Set(['I0(1)', 'I0(2)']))
  })

  it('degenerate case: an atom with no variables at all', () => {
    const rows = run(`${E0(2, 'h0: number')}I0(a) :- E0(a, a), E0(0, 0).`, {
      E0: [[1, 1], [0, 0]],
    })
    expect(rows).toEqual(new Set(['I0(1)', 'I0(0)']))
  })

  it('degenerate case: an all-placeholder atom', () => {
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

// The negated form: `!E(0)` shares no variable with the rest of the body either,
// so the antijoin has no key to work on. Both sides are re-keyed under one
// sentinel and the left survives exactly when the unit is *absent* — i.e. when
// the negated atom matched nothing. Fixing the positive case is what made this
// reachable at all; before that, the plan died earlier.
describe('negated existence tests', () => {
  it('passes when the negated atom matches nothing', () => {
    expect(run(`${E0(1, 'h0: number')}I0(a) :- E0(a), !E0(0).`, { E0: [[1], [2]] })).toEqual(
      new Set(['I0(1)', 'I0(2)']),
    )
  })

  it('blocks everything when it matches', () => {
    expect(run(`${E0(1, 'h0: number')}I0(a) :- E0(a), !E0(0).`, { E0: [[0], [1]] })).toEqual(
      new Set(),
    )
  })

  it('an all-placeholder negated atom is "the relation is empty"', () => {
    // E0 is non-empty whenever E0(a) holds, so this derives nothing, ever.
    expect(run(`${E0(1, 'h0: number')}I0(a) :- E0(a), !E0(_).`, { E0: [[1]] })).toEqual(new Set())
  })

  it('reacts to the negated fact appearing and disappearing', () => {
    const source = `${E0(1, 'h0: number')}I0(a) :- E0(a), !E0(0).`
    expect(run(source, { E0: [[1]] })).toEqual(new Set(['I0(1)']))
    expect(run(source, { E0: [[1], [0]] })).toEqual(new Set())
  })
})

// The unit is deduplicated, which is semantics rather than optimisation: a
// relation of N rows must not multiply its cartesian partner N-fold. Sets hide
// that, so this counts multiplicities directly.
describe('existence tests do not multiply multiplicities', () => {
  function counts(source: string, facts: Record<string, Row[]>): Map<string, number> {
    const out = new Map<string, number>()
    executeProgram(
      parseProgram(source, { grammarSource: 'mult.dl' }),
      new Map(Object.entries(facts)),
      {},
      (rel, row, diff) => {
        const k = `${rel}(${row.join(', ')})`
        out.set(k, (out.get(k) ?? 0) + diff)
      },
    )
    return out
  }

  it('one row per derivation, however large the witness relation', () => {
    for (const n of [1, 3, 8]) {
      const facts = { E0: [[0] as Row, ...Array.from({ length: n }, (_, i) => [i + 1] as Row)] }
      const got = counts(`${E0(1, 'h0: number')}I0(a) :- E0(a), E0(b).`, facts)
      // Every E0 row qualifies exactly once — not once per witness.
      expect([...got.values()].every((v) => v === 1)).toBe(true)
      expect(got.size).toBe(n + 1)
    }
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
