// Fuzzing the shadow compiler against arbitrary generated programs.
//
// `properties.test.ts` checks four shapes I designed on purpose, which means
// it checks the cases I already had in mind. This file generates whole
// programs — random arities, shared variables, constants, placeholders,
// negation, filters, chained IDBs, multi-rule heads — and asserts the same
// laws over all of them, with the forward engine as the oracle.
//
// A failure here prints the generated rules, so a counterexample is a program
// you can paste into `inspect` and read.

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parseProgram } from '@flow-ts/parsing'
import { compileShadow } from '../../src/shadow/index.js'
import {
  applyDeletes,
  backward,
  countCandidates,
  dedupe,
  deleteToFixpoint,
  key,
  liveRows,
  subset,
} from './_harness.js'
import { type GenProgram, programGen } from './_gen.js'

/** A generated program plus a request drawn from one of its live views.
 *  `null` when the program derives nothing (common and uninteresting). */
const withRequest = programGen.map((p) => {
  const facts = dedupe(p.facts)
  for (const idb of p.idbs) {
    const view = [...liveRows(p.source, facts, idb.name).values()]
    if (view.length > 0) return { p, facts, view: idb.name, target: view[0]! }
  }
  return null
})

/** Counterexample reporting: the program is the interesting part. */
const describeProgram = (p: GenProgram, view: string, target: readonly unknown[]): string =>
  `\nrules:\n  ${p.rules.join('\n  ')}\nrequest: Del_${view}(${target.join(', ')})\n`

describe('generated programs', () => {
  it('every generated program is legal Datalog and compiles', () => {
    fc.assert(
      fc.property(programGen, (p) => {
        const program = parseProgram(p.source, { grammarSource: 'gen.dl' })
        const shadow = compileShadow(program)
        // The shadow program must itself parse — it is fed straight back in.
        parseProgram(shadow.source, { grammarSource: 'shadow.dl' })
        return true
      }),
      { numRuns: 200 },
    )
  })

  it('soundness: every candidate is a tuple that currently exists', () => {
    let exercised = 0
    fc.assert(
      fc.property(withRequest, (input) => {
        if (!input) return true
        exercised++
        const { p, facts, view, target } = input
        const { del } = backward(p.source, facts, view, target)
        for (const [rel, rows] of del) {
          const present = new Set((facts[rel] ?? []).map(key))
          for (const k of rows.keys()) {
            if (!present.has(k)) {
              throw new Error(`hallucinated candidate in ${rel}${describeProgram(p, view, target)}`)
            }
          }
        }
        return true
      }),
      { numRuns: 300 },
    )
    expect(exercised).toBeGreaterThan(50)
  })

  it('support: a derived row always has candidates', () => {
    let exercised = 0
    fc.assert(
      fc.property(withRequest, (input) => {
        if (!input) return true
        exercised++
        const { p, facts, view, target } = input
        const { del } = backward(p.source, facts, view, target)
        if (countCandidates(del) === 0) {
          throw new Error(`derived but unsupported${describeProgram(p, view, target)}`)
        }
        return true
      }),
      { numRuns: 300 },
    )
    expect(exercised).toBeGreaterThan(50)
  })

  it('completeness (negation-free): one pass is enough', () => {
    let exercised = 0
    fc.assert(
      fc.property(withRequest, (input) => {
        if (!input) return true
        const { p, facts, view, target } = input
        if (p.rules.some((r) => r.includes('!'))) return true
        exercised++
        const { del } = backward(p.source, facts, view, target)
        const after = liveRows(p.source, applyDeletes(facts, del), view)
        if (after.has(key(target))) {
          throw new Error(`target survived its own support${describeProgram(p, view, target)}`)
        }
        return true
      }),
      { numRuns: 300 },
    )
    expect(exercised).toBeGreaterThan(10)
  })

  // With negation a single pass is *not* enough: retracting a fact can unblock
  // a derivation a negated atom was suppressing, so the target reappears. The
  // fuzzer found this — see `negation re-derives` in properties.test.ts for the
  // minimal case. Iterating to a fixpoint is the general law, and it holds for
  // every program the generator produces.
  it('completeness (general): iterating to a fixpoint always removes the target', () => {
    let exercised = 0
    let neededMoreThanOneRound = 0
    fc.assert(
      fc.property(withRequest, (input) => {
        if (!input) return true
        exercised++
        const { p, facts, view, target } = input
        const r = deleteToFixpoint(p.source, facts, view, target)
        if (r.rounds > 1) neededMoreThanOneRound++
        if (!r.removed) {
          throw new Error(
            `fixpoint stalled (${r.stalled}) after ${r.rounds} rounds${describeProgram(p, view, target)}`,
          )
        }
        return true
      }),
      { numRuns: 300 },
    )
    expect(exercised).toBeGreaterThan(50)
    // Programs that genuinely need a second round are rare, so asserting a
    // floor here would be seed-dependent. `negation re-derives` in
    // properties.test.ts pins that case deterministically instead.
    void neededMoreThanOneRound
  })

  it('stability: no request yields no candidates (GetPut)', () => {
    fc.assert(
      fc.property(programGen, (p) => {
        const facts = dedupe(p.facts)
        // Any view will do; seeding nothing must derive nothing anywhere.
        for (const idb of p.idbs) {
          const { del, ins } = backward(
            p.source,
            facts,
            idb.name,
            // A row that cannot exist: out of the generator's domain.
            Array.from({ length: idb.arity }, () => 9999),
          )
          if (countCandidates(del) !== 0 || countCandidates(ins) !== 0) {
            throw new Error(`candidates from an underivable request${describeProgram(p, idb.name, [])}`)
          }
        }
        return true
      }),
      { numRuns: 200 },
    )
  })

  it('monotonicity: a delete never adds rows to a negation-free program', () => {
    let exercised = 0
    fc.assert(
      fc.property(withRequest, (input) => {
        if (!input) return true
        const { p, facts, view, target } = input
        if (p.rules.some((r) => r.includes('!'))) return true // negation is non-monotone by design
        exercised++
        const { del } = backward(p.source, facts, view, target)
        const before = liveRows(p.source, facts, view)
        const after = liveRows(p.source, applyDeletes(facts, del), view)
        if (!subset(after, before)) {
          throw new Error(`delete grew the view${describeProgram(p, view, target)}`)
        }
        return true
      }),
      { numRuns: 250 },
    )
    expect(exercised).toBeGreaterThan(10)
  })
})
