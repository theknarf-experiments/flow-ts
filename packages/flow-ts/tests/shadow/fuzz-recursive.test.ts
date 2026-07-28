// Fuzzing the shadow compiler over *recursive* programs.
//
// Recursion is the case the design argument was least sure about. The shadow of
// a recursive rule is itself recursive, so `Del_R` lands in the same SCC as `R`
// and its fixpoint is the support set — every source tuple participating in any
// derivation of the target. That is why-provenance, computed by the forward
// engine on a program it generated for itself.
//
// The consequence is that recursion isn't *uninvertible*, it's maximally
// ambiguous: deleting the whole support certainly severs the target, but a
// minimal cut is a different (and harder) question. So these properties assert
// soundness and sufficiency, not minimality.

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parseProgram } from '@flow-ts/parsing'
import { compileShadow, resolveBackward } from '../../src/shadow/index.js'
import {
  applyDeletes,
  backward,
  countCandidates,
  dedupe,
  deleteToFixpoint,
  key,
  liveRows,
} from './_harness.js'
import { type GenProgram, recursiveProgramGen } from './_gen.js'

const PARSE = { parse: (src: string) => parseProgram(src, { grammarSource: 'shadow.dl' }), views: 'all' as const }

const withRequest = recursiveProgramGen.map((p) => {
  const facts = dedupe(p.facts)
  for (const idb of p.idbs) {
    const view = [...liveRows(p.source, facts, idb.name).values()]
    if (view.length > 0) return { p, facts, view: idb.name, target: view[0]! }
  }
  return null
})

const show = (p: GenProgram, view: string, target: readonly unknown[]): string =>
  `\nrules:\n  ${p.rules.join('\n  ')}\nrequest: ${view}(${target.join(', ')})\n`

/** Is any rule genuinely self-referential? Guards the coverage assertions. */
const isRecursive = (p: GenProgram): boolean =>
  p.rules.some((r) => {
    const head = r.slice(0, r.indexOf('('))
    return new RegExp(`:-.*\\b${head}\\(`).test(r)
  })

describe('recursive programs', () => {
  it('the generator produces recursion, and it plans', () => {
    let recursive = 0
    fc.assert(
      fc.property(recursiveProgramGen, (p) => {
        if (isRecursive(p)) recursive++
        const program = parseProgram(p.source, { grammarSource: 'gen.dl' })
        // Both the program and its shadow have to be runnable.
        liveRows(p.source, dedupe(p.facts), p.idbs[0]!.name)
        parseProgram(compileShadow(program).source, { grammarSource: 'shadow.dl' })
        return true
      }),
      { numRuns: 200 },
    )
    expect(recursive).toBeGreaterThan(50)
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
            if (!present.has(k)) throw new Error(`hallucinated candidate${show(p, view, target)}`)
          }
        }
        return true
      }),
      { numRuns: 250 },
    )
    expect(exercised).toBeGreaterThan(40)
  })

  it('support: the shadow fixpoint finds something for every derived row', () => {
    let exercised = 0
    fc.assert(
      fc.property(withRequest, (input) => {
        if (!input) return true
        exercised++
        const { p, facts, view, target } = input
        const { del } = backward(p.source, facts, view, target)
        if (countCandidates(del) === 0) {
          throw new Error(`derived but unsupported${show(p, view, target)}`)
        }
        return true
      }),
      { numRuns: 250 },
    )
    expect(exercised).toBeGreaterThan(40)
  })

  it('sufficiency: deleting the whole support severs the target', () => {
    let exercised = 0
    fc.assert(
      fc.property(withRequest, (input) => {
        if (!input) return true
        const { p, facts, view, target } = input
        if (p.rules.some((r) => r.includes('!'))) return true // needs the fixpoint
        exercised++
        const { del } = backward(p.source, facts, view, target)
        const after = liveRows(p.source, applyDeletes(facts, del), view)
        if (after.has(key(target))) {
          throw new Error(`survived its own support${show(p, view, target)}`)
        }
        return true
      }),
      { numRuns: 250 },
    )
    expect(exercised).toBeGreaterThan(10)
  })

  it('the fixpoint loop terminates and removes the target', () => {
    let exercised = 0
    fc.assert(
      fc.property(withRequest, (input) => {
        if (!input) return true
        exercised++
        const { p, facts, view, target } = input
        const r = deleteToFixpoint(p.source, facts, view, target)
        if (!r.removed) {
          throw new Error(`stalled (${r.stalled}) after ${r.rounds}${show(p, view, target)}`)
        }
        return true
      }),
      { numRuns: 250 },
    )
    expect(exercised).toBeGreaterThan(40)
  })

  it('resolveBackward: ok still never lies under recursion', () => {
    let ok = 0
    fc.assert(
      fc.property(withRequest, (input) => {
        if (!input) return true
        const { p, facts, view, target } = input
        const program = parseProgram(p.source, { grammarSource: 'gen.dl' })
        const r = resolveBackward(program, facts, { rel: view, row: target }, PARSE)
        if (r.status !== 'ok') return true
        ok++
        const after = liveRows(
          p.source,
          applyDeletes(
            facts,
            new Map(
              [...new Set(r.changes.map((c) => c.rel))].map((rel) => [
                rel,
                new Map(
                  r.changes.filter((c) => c.rel === rel).map((c) => [key(c.row), c.row]),
                ),
              ]),
            ),
          ),
          view,
        )
        if (after.has(key(target))) {
          throw new Error(`reported ok but the row is still derived${show(p, view, target)}`)
        }
        return true
      }),
      { numRuns: 250 },
    )
    expect(ok).toBeGreaterThan(20)
  })
})
