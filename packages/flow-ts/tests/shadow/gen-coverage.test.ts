// What the generator actually generates.
//
// Every property in the fuzz suites is only as good as the programs fed to it,
// and a generator can drift silently — a constraint added to dodge one engine
// gap can quietly stop producing negation, and the suite goes on passing while
// testing less. So the feature mix is asserted here rather than assumed, and
// the numbers are printed so a change in them is visible in the run.
//
// These are floors, not targets. They are set well below what the generator
// currently produces, so ordinary drift doesn't fail the build but a collapse
// does.

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parseProgram } from '@flow-ts/parsing'
import { compileShadow } from '../../src/shadow/index.js'
import { inferRelationTypes } from '../../src/typing/index.js'
import { dedupe, liveRows } from './_harness.js'
import { type GenProgram, programGen, recursiveProgramGen } from './_gen.js'

interface Tally {
  programs: number
  rules: number
  [feature: string]: number
}

function survey(gen: fc.Arbitrary<GenProgram>, runs: number, label: string): Tally {
  const t: Tally = { programs: 0, rules: 0 }
  const bump = (k: string, n = 1) => {
    t[k] = (t[k] ?? 0) + n
  }
  fc.assert(
    fc.property(gen, (p) => {
      t.programs++
      t.rules += p.rules.length
      const text = p.rules.join('\n')
      const decls = p.source

      if (/!\w/.test(text)) bump('negation')
      if (/ < /.test(text)) bump('comparison')
      if (/\(_|, _/.test(text)) bump('placeholder')
      if (/"[a-z]"/.test(text)) bump('stringConstant')
      if (/[(,] ?\d/.test(text)) bump('numberConstant')
      if (/: string/.test(decls)) bump('stringColumn')
      if (/:-.*\bI\d/.test(text)) bump('idbInBody')

      const heads = p.rules.map((r) => r.slice(0, r.indexOf('(')))
      if (new Set(heads).size !== heads.length) bump('multiRuleHead')
      if (p.rules.some((r) => new RegExp(`:-.*\\b${r.slice(0, r.indexOf('('))}\\(`).test(r))) {
        bump('recursion')
      }

      // Existence tests: an atom sharing nothing with the rest of its rule.
      for (const r of p.rules) {
        const body = r.slice(r.indexOf(':-') + 2)
        const head = r.slice(r.indexOf('(') + 1, r.indexOf(')'))
        for (const m of body.matchAll(/!?([A-Z]\w*)\(([^)]*)\)/g)) {
          const vars = m[2]!.split(',').map((x) => x.trim()).filter((x) => /^[abst]$/.test(x))
          const rest = body.split(m[0]!).join('')
          if (!vars.some((v) => head.includes(v) || rest.includes(v))) bump('existenceTest')
        }
      }

      const facts = dedupe(p.facts)
      const shadow = compileShadow(parseProgram(p.source, { grammarSource: 'g.dl' }))
      if (shadow.refusals.length > 0) bump('someRefusal')
      if (shadow.seeds.length === p.idbs.length) bump('allViewsSeedable')
      if (inferRelationTypes(parseProgram(p.source, { grammarSource: 'g.dl' })).unresolved.length > 0) {
        bump('unresolvedTypes')
      }
      for (const idb of p.idbs) {
        if (liveRows(p.source, facts, idb.name).size > 0) {
          bump('derivesSomething')
          break
        }
      }
      return true
    }),
    { numRuns: runs },
  )

  const pct = (k: string) => `${(((t[k] ?? 0) / t.programs) * 100).toFixed(0)}%`
  const keys = Object.keys(t).filter((k) => k !== 'programs' && k !== 'rules')
  console.log(
    `\n${label}: ${t.programs} programs, ${(t.rules / t.programs).toFixed(1)} rules each\n` +
      keys.map((k) => `  ${k.padEnd(18)} ${pct(k)}`).join('\n'),
  )
  return t
}

describe('generator coverage', () => {
  it('non-recursive programs reach every feature the compiler handles', () => {
    const t = survey(programGen, 400, 'non-recursive')
    const atLeast = (k: string, pctFloor: number) =>
      expect({ [k]: ((t[k] ?? 0) / t.programs) * 100 }).toMatchObject({
        [k]: expect.any(Number),
      }) && expect((t[k] ?? 0) / t.programs).toBeGreaterThan(pctFloor / 100)

    atLeast('derivesSomething', 30)
    atLeast('negation', 30)
    atLeast('comparison', 30)
    atLeast('placeholder', 20)
    atLeast('multiRuleHead', 30)
    atLeast('idbInBody', 25)
    atLeast('existenceTest', 20)
    // Strings were absent entirely until this suite went looking.
    atLeast('stringColumn', 40)
    atLeast('stringConstant', 5)
    atLeast('numberConstant', 20)
  })

  it('recursive programs actually recurse', () => {
    const t = survey(recursiveProgramGen, 300, 'recursive')
    // Floors, not targets, and set with room: these are sample statistics over
    // a few hundred random programs, so a threshold pressed up against the
    // observed rate is a flaky test rather than a strict one. ~45% observed.
    expect((t.recursion ?? 0) / t.programs).toBeGreaterThan(0.25)
    expect((t.derivesSomething ?? 0) / t.programs).toBeGreaterThan(0.2)
  })

  it('both seedable and refusing programs occur, or the refusal paths go untested', () => {
    const t = survey(programGen, 300, 'seedability')
    expect(t.allViewsSeedable ?? 0).toBeGreaterThan(30)
    expect(t.someRefusal ?? 0).toBeGreaterThan(5)
  })
})
