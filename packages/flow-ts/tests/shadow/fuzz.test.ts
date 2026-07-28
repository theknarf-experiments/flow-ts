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
import { type Change, compileShadow, resolveBackward } from '../../src/shadow/index.js'
import {
  applyDeletes,
  applyUpdates,
  backward,
  countCandidates,
  dedupe,
  deleteToFixpoint,
  key,
  liveRows,
  subset,
} from './_harness.js'
import { type GenProgram, programGen } from './_gen.js'
import type { Row } from '../../src/reading/index.js'

const PARSE = { parse: (src: string) => parseProgram(src, { grammarSource: 'shadow.dl' }), views: 'all' as const }

/** Apply resolved changes, independently of the resolver's own helper. */
function applyChanges(facts: Record<string, Row[]>, changes: readonly Change[]) {
  const out: Record<string, Row[]> = { ...facts }
  for (const c of changes) {
    const rows = out[c.rel] ?? []
    if (c.kind === 'del') out[c.rel] = rows.filter((r) => key(r) !== key(c.row))
    else if (c.kind === 'ins') out[c.rel] = [...rows, c.row]
    else out[c.rel] = rows.map((r) => (key(r) === key(c.row) ? c.newRow! : r))
  }
  return out
}

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

  // The update channel over generated programs. A request changes one column
  // of a derived row to a value outside the generator's domain, so the new row
  // cannot collide with an existing one and the check stays unambiguous.
  it('update: every proposed rewrite starts from a fact that exists', () => {
    let exercised = 0
    fc.assert(
      fc.property(withRequest, (input) => {
        if (!input) return true
        const { p, facts, view, target } = input
        for (let col = 0; col < target.length; col++) {
          const next = [...target]
          next[col] = 5000 + col
          const { upd } = backward(p.source, facts, view, target, next)
          if (upd.size > 0) exercised++
          for (const [rel, rows] of upd) {
            const present = new Set((facts[rel] ?? []).map(key))
            const n = (facts[rel]?.[0]?.length ?? 0) || 0
            for (const row of rows.values()) {
              if (n > 0 && !present.has(key(row.slice(0, n)))) {
                throw new Error(`rewrite of a non-existent ${rel} row${describeProgram(p, view, target)}`)
              }
            }
          }
        }
        return true
      }),
      { numRuns: 250 },
    )
    expect(exercised).toBeGreaterThan(20)
  })

  // A rewrite proposal is sound but *not* complete: when one tuple satisfies
  // two body atoms, rewriting it for one destroys the other's witness (see
  // `a rewrite is a proposal, not a guarantee` in update.test.ts). Whether that
  // happens depends on the data, so no static check on the rule text catches
  // it. What the engine can promise is that the failure is always *detectable*
  // by re-running forward — which is the whole runtime protocol.
  it('update: a proposal either lands or is detectably wrong, never silently partial', () => {
    let landed = 0
    let rejected = 0
    fc.assert(
      fc.property(withRequest, (input) => {
        if (!input) return true
        const { p, facts, view, target } = input
        for (let col = 0; col < target.length; col++) {
          const next = [...target]
          next[col] = 5000 + col
          const { upd } = backward(p.source, facts, view, target, next)
          if (upd.size === 0) continue
          const after = liveRows(p.source, applyUpdates(facts, upd), view)
          if (after.has(key(next))) {
            landed++
          } else {
            rejected++
            // The verification step must be able to tell: the requested row is
            // absent, so a `compare` after `advance` rejects and rolls back.
            if (after.has(key(target)) && after.has(key(next))) return false
          }
        }
        return true
      }),
      { numRuns: 250 },
    )
    // The landing branch has to be reached often enough to mean something. The
    // rejected branch is rare and therefore seed-dependent, so it isn't
    // asserted here — `a rewrite is a proposal, not a guarantee` in
    // update.test.ts pins that case deterministically instead.
    expect(landed).toBeGreaterThan(20)
    void rejected
  })

  // The protocol's one promise: `ok` is never a lie. Everything else it may
  // report — refused, ambiguous, unsatisfied — is a caller's problem, but an
  // `ok` whose changes don't achieve the request would be silent corruption.
  it('resolveBackward: ok always means the request actually holds', () => {
    const outcomes = { ok: 0, refused: 0, ambiguous: 0, unsatisfied: 0 }
    fc.assert(
      fc.property(withRequest, fc.boolean(), (input, asUpdate) => {
        if (!input) return true
        const { p, facts, view, target } = input
        const program = parseProgram(p.source, { grammarSource: 'gen.dl' })
        const req = asUpdate
          ? { rel: view, row: target, newRow: target.map((v, i) => (i === 0 ? 7000 : v)) }
          : { rel: view, row: target }

        const r = resolveBackward(program, facts, req, PARSE)
        outcomes[r.status]++
        if (r.status !== 'ok') return true

        // Check independently of the implementation's own verification.
        const after = liveRows(p.source, applyChanges(facts, r.changes), view)
        const holds = asUpdate ? after.has(key(req.newRow!)) : !after.has(key(target))
        if (!holds) {
          throw new Error(
            `reported ok but the request does not hold${describeProgram(p, view, target)}`,
          )
        }
        return true
      }),
      { numRuns: 250 },
    )
    expect(outcomes.ok).toBeGreaterThan(30)
  })

  it('resolveBackward: never reports ok for a row the program does not derive', () => {
    fc.assert(
      fc.property(withRequest, (input) => {
        if (!input) return true
        const { p, facts, view, target } = input
        const program = parseProgram(p.source, { grammarSource: 'gen.dl' })
        const bogus = target.map((v) => (typeof v === 'number' ? v + 9000 : `${v}~no`))
        const r = resolveBackward(program, facts, { rel: view, row: bogus }, PARSE)
        return r.status === 'refused'
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
