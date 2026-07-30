// Unit tests for the shadow-rule compiler: the *shape* of what it emits.
//
// The compiler turns each forward rule into "shadow" rules that derive the
// backward direction — given a request to remove a derived tuple, which EDB
// tuples could have produced it. The shadow rules are ordinary Datalog, run
// on the ordinary engine, so these tests mostly assert on generated source.

import { describe, expect, it } from 'vitest'
import { parseProgram } from '../../src/parsing/index.js'
import { compileShadow } from '../../src/shadow/index.js'

/** Generated rule lines only, trimmed — easier to assert on than raw source. */
function ruleLines(source: string): string[] {
  const at = source.indexOf('.rule')
  return source
    .slice(at + '.rule'.length)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

const PROJECTION = `\
.in
.decl Task(path: string, status: string, text: string, line: number)
.input Task.csv

.printsize
.decl Open(p: string, t: string)

.rule
Open(p, t) :- Task(p, "open", t, l).
`

describe('deletion shadow: body replay', () => {
  it('recovers existential columns by replaying the body', () => {
    const shadow = compileShadow(parseProgram(PROJECTION))
    expect(ruleLines(shadow.source)).toContain(
      'Del_Task(p, "open", t, l) :- Del_Open(p, t), Task(p, "open", t, l).',
    )
  })

  it('seeds the request through an EDB channel', () => {
    const shadow = compileShadow(parseProgram(PROJECTION))
    expect(ruleLines(shadow.source)).toContain('Del_Open(p, t) :- Seed_Open(p, t).')
    expect(shadow.seeds).toContain('Open')
    // The seed is an EDB of the shadow program, so it must be typed.
    expect(shadow.source).toContain('.decl Seed_Open(p: string, t: string)')
  })

  it('freshens placeholders so they can be projected', () => {
    const shadow = compileShadow(
      parseProgram(PROJECTION.replace('Task(p, "open", t, l)', 'Task(p, "open", t, _)')),
    )
    const line = ruleLines(shadow.source).find((l) => l.startsWith('Del_Task('))
    expect(line).toBeDefined()
    // The placeholder became a fresh variable in both head and replayed body.
    expect(line).not.toContain('_)')
    expect(line).toMatch(/^Del_Task\(p, "open", t, (\w+)\) :- Del_Open\(p, t\), Task\(p, "open", t, \1\)\.$/)
  })

  it('emits one candidate per positive body atom', () => {
    const shadow = compileShadow(
      parseProgram(`\
.in
.decl Task(id: number, pid: number)
.input Task.csv
.decl Person(pid: number, name: string)
.input Person.csv

.printsize
.decl Assigned(id: number, name: string)

.rule
Assigned(i, n) :- Task(i, p), Person(p, n).
`),
    )
    const lines = ruleLines(shadow.source)
    expect(lines).toContain(
      'Del_Task(i, p) :- Del_Assigned(i, n), Task(i, p), Person(p, n).',
    )
    expect(lines).toContain(
      'Del_Person(p, n) :- Del_Assigned(i, n), Task(i, p), Person(p, n).',
    )
  })

  it('fans out over every rule of a multi-rule head', () => {
    const shadow = compileShadow(
      parseProgram(`\
.in
.decl A(x: number)
.input A.csv
.decl B(x: number)
.input B.csv

.printsize
.decl H(x: number)

.rule
H(x) :- A(x).
H(x) :- B(x).
`),
    )
    const lines = ruleLines(shadow.source)
    // Killing a disjunction means killing every disjunct: both fire.
    expect(lines).toContain('Del_A(x) :- Del_H(x), A(x).')
    expect(lines).toContain('Del_B(x) :- Del_H(x), B(x).')
  })
})

describe('polarity', () => {
  it('flips a negated body atom onto the insert channel', () => {
    const shadow = compileShadow(
      parseProgram(`\
.in
.decl Item(x: number)
.input Item.csv
.decl Hidden(x: number)
.input Hidden.csv

.printsize
.decl Visible(x: number)

.rule
Visible(x) :- Item(x), !Hidden(x).
`),
    )
    const lines = ruleLines(shadow.source)
    // Two ways to un-derive Visible(x): drop the Item, or add the Hidden.
    expect(lines).toContain('Del_Item(x) :- Del_Visible(x), Item(x), !Hidden(x).')
    expect(lines).toContain('Ins_Hidden(x) :- Del_Visible(x), Item(x), !Hidden(x).')
  })
})

describe('refusals', () => {
  it('refuses an aggregation head, with a reason', () => {
    const shadow = compileShadow(
      parseProgram(`\
.in
.decl Hours(proj: string, who: string, h: number)
.input Hours.csv

.printsize
.decl Total(proj: string, s: number)

.rule
Total(p, sum(h)) :- Hours(p, w, h).
`),
    )
    expect(shadow.refusals.length).toBeGreaterThan(0)
    expect(shadow.refusals[0]!.reason).toMatch(/aggregation/i)
  })

  it('inverts arithmetic in the head where it can — see head-arith.test.ts', () => {
    const shadow = compileShadow(
      parseProgram(`\
.in
.decl R(x: number)
.input R.csv

.printsize
.decl S(y: number)

.rule
S(x + 1) :- R(x).
`),
    )
    const lines = ruleLines(shadow.source)
    // Deletion binds the computed position and replays the computation…
    expect(lines.some((l) => l.startsWith('Del_R(') && l.includes('== x + 1'))).toBe(true)
    // …and the update channel undoes the arithmetic.
    expect(lines.some((l) => l.startsWith('Upd_R(') && l.includes('- 1'))).toBe(true)
    // The only refusal left is insertion, which would need a value for `x`.
    expect(shadow.refusals.every((r) => /insert/i.test(r.reason))).toBe(true)
  })

  it('but a body *filter* needs no inversion — replay re-checks it', () => {
    // Comparisons here are filters over already-bound variables, not
    // bindings (`S(y) :- R(x), y = x + 1.` is rejected by the planner — see
    // tests/executing/comparisons.test.ts). A filter needs no inverse at all:
    // the shadow rule replays it, so candidates are drawn only from the rows
    // that actually satisfied it.
    const shadow = compileShadow(
      parseProgram(`\
.in
.decl R(x: number, y: number)
.input R.csv

.printsize
.decl S(x: number)

.rule
S(x) :- R(x, y), y < 10.
`),
    )
    // Deletion is fully determined here. Insertion is not — `y` is in the body
    // but not the head, so there is no value to insert — and that refusal is
    // about the insert channel, not this one.
    expect(shadow.refusals.filter((r) => !/insert/i.test(r.reason))).toEqual([])
    expect(ruleLines(shadow.source)).toContain('Del_R(x, y) :- Del_S(x), R(x, y), y < 10.')
  })

  it('seeds an untyped IDB decl by inferring its column types', () => {
    // `.decl H()` leaves the arity to the rules — which is how flow-md declares
    // every query. The types are recoverable from the body, so this is seedable.
    const shadow = compileShadow(
      parseProgram(`\
.in
.decl A(x: number)
.input A.csv

.printsize
.decl H()

.rule
H(x) :- A(x).
`),
    )
    expect(shadow.seeds).toContain('H')
    expect(shadow.source).toContain('.decl Seed_H(c0: number)')
    expect(shadow.refusals).toEqual([])
  })

  it('refuses only when the types genuinely cannot be recovered', () => {
    const shadow = compileShadow(
      parseProgram(`\
.in
.decl A(x: number)
.input A.csv

.printsize
.decl H()
.decl Orphan()

.rule
H(x) :- A(x).
`),
    )
    expect(shadow.seeds).toContain('H')
    expect(shadow.seeds).not.toContain('Orphan')
    // And it says *why*, rather than just declining.
    expect(shadow.refusals.find((r) => r.subject === 'Orphan')?.reason).toMatch(/no rules/i)
  })
})

describe('the emitted program is valid Datalog', () => {
  it('round-trips through the parser', () => {
    for (const src of [PROJECTION]) {
      const shadow = compileShadow(parseProgram(src))
      expect(() => parseProgram(shadow.source, { grammarSource: 'shadow.dl' })).not.toThrow()
    }
  })
})
