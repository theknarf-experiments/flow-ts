// Asking for a row to *exist*.
//
// `Ins_` channels have been in the compiler since the beginning, but only ever
// as a side-effect: un-deriving `Visible(x) :- Item(x), !Hidden(x)` can be done
// by adding the Hidden, so a delete request produced an insert downstream.
// Nothing could ask for an insertion directly, which meant "add a task" — the
// thing flow-md's `/insert` endpoint does — had no path through the engine.
//
// The polarity algebra is the mirror of deletion, and the asymmetry is the
// interesting part:
//
//   delete  fans out over rules (killing a disjunction kills every disjunct)
//           and picks *one* body atom per rule
//   insert  picks *one* rule (satisfying a disjunction needs only one)
//           and fans out over that rule's body (a conjunction needs all of it)
//
// So deletion's ambiguity is which atom, and insertion's is which rule. The
// second needs an annotation; the first often doesn't.

import { describe, expect, it } from 'vitest'
import { parseProgram } from '../../src/parsing/index.js'
import type { Row } from '../../src/reading/index.js'
import { compileShadow, openBackwardSession, resolveBackward } from '../../src/shadow/index.js'
import { type Facts, key, liveRows } from './_harness.js'

const PARSE = { parse: (src: string) => parseProgram(src, { grammarSource: 's.dl' }), views: 'all' as const }

function ruleLines(source: string): string[] {
  const at = source.indexOf('.rule')
  return source
    .slice(at + '.rule'.length)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

const applyChanges = (facts: Facts, changes: ReadonlyArray<{ kind: string; rel: string; row: Row }>): Facts => {
  const out: Facts = { ...facts }
  for (const c of changes) {
    const rows = out[c.rel] ?? []
    if (c.kind === 'ins') {
      out[c.rel] = rows.some((r) => key(r) === key(c.row)) ? rows : [...rows, c.row]
    } else if (c.kind === 'del') {
      out[c.rel] = rows.filter((r) => key(r) !== key(c.row))
    }
  }
  return out
}

// A single rule, every head variable reaching the body: fully determined.
const COPY_SRC = `\
.in
.decl Item(id: number, name: string)
.input Item.csv

.printsize
.decl Named(id: number, name: string)

.rule
Named(i, n) :- Item(i, n).
`
const COPY = parseProgram(COPY_SRC, { grammarSource: 'c.dl' })

describe('compilation', () => {
  it('seeds the insert channel', () => {
    const shadow = compileShadow(COPY)
    expect(shadow.source).toContain('.decl SeedIns_Named(')
    expect(ruleLines(shadow.source)).toContain('Ins_Named(id, name) :- SeedIns_Named(id, name).')
  })

  it('fans out over the body — a conjunction needs all of it', () => {
    const shadow = compileShadow(
      parseProgram(`\
.in
.decl A(x: number)
.input A.csv
.decl B(x: number)
.input B.csv

.printsize
.decl Both(x: number)

.rule
Both(x) :- A(x), B(x).
`),
    )
    const lines = ruleLines(shadow.source)
    expect(lines).toContain('Ins_A(x) :- Ins_Both(x).')
    expect(lines).toContain('Ins_B(x) :- Ins_Both(x).')
  })

  it('flips polarity for a negated atom', () => {
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
    // To make it visible: add the Item, and remove whatever hides it.
    expect(lines).toContain('Ins_Item(x) :- Ins_Visible(x).')
    expect(lines).toContain('Del_Hidden(x) :- Ins_Visible(x).')
  })
})

describe('behaviour', () => {
  const FACTS: Facts = { Item: [[1, 'one']] }

  it('inserting a derived row inserts the source fact', () => {
    const r = resolveBackward(COPY, FACTS, { rel: 'Named', row: [2, 'two'], insert: true }, PARSE)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.changes).toEqual([{ kind: 'ins', rel: 'Item', row: [2, 'two'] }])
    expect(liveRows(COPY_SRC, applyChanges(FACTS, r.changes), 'Named').has(key([2, 'two']))).toBe(
      true,
    )
  })

  it('refuses to insert a row that is already there', () => {
    const r = resolveBackward(COPY, FACTS, { rel: 'Named', row: [1, 'one'], insert: true }, PARSE)
    expect(r.status).toBe('refused')
    if (r.status !== 'refused') return
    expect(r.reason).toMatch(/already derived/i)
  })

  it('checks the request shape like any other', () => {
    const r = resolveBackward(COPY, FACTS, { rel: 'Named', row: ['x', 2], insert: true }, PARSE)
    expect(r.status).toBe('refused')
    if (r.status !== 'refused') return
    expect(r.reason).toMatch(/column 0 expects number/i)
  })

  it('verifies, so an insert that does not take is reported', () => {
    // `Blocked` can never hold: the same fact would have to be absent for the
    // negation and present for the positive atom.
    const SRC = parseProgram(
      `\
.in
.decl A(x: number)
.input A.csv

.printsize
.decl Blocked(x: number)

.rule
Blocked(x) :- A(x), !A(x).
`,
      { grammarSource: 'b.dl' },
    )
    const r = resolveBackward(SRC, { A: [] }, { rel: 'Blocked', row: [1], insert: true }, PARSE)
    expect(r.status).toBe('unsatisfied')
  })

  it('adds the item and clears what hid it', () => {
    const SRC = parseProgram(
      `\
.in
.decl Item(x: number)
.input Item.csv
.decl Hidden(x: number)
.input Hidden.csv

.printsize
.decl Visible(x: number)

.rule
Visible(x) :- Item(x), !Hidden(x).
`,
      { grammarSource: 'v.dl' },
    )
    const facts: Facts = { Item: [], Hidden: [[1]] }
    const r = resolveBackward(SRC, facts, { rel: 'Visible', row: [1], insert: true }, PARSE)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.changes).toEqual(
      expect.arrayContaining([
        { kind: 'ins', rel: 'Item', row: [1] },
        { kind: 'del', rel: 'Hidden', row: [1] },
      ]),
    )
  })
})

describe('what it will not guess', () => {
  it('refuses when the body needs a value the head does not carry', () => {
    // `l` appears in Task but nowhere in the head, so there is no way to know
    // what line the new task should be on.
    const SRC = parseProgram(
      `\
.in
.decl Task(p: string, t: string, l: number)
.input Task.csv

.printsize
.decl Open(p: string, t: string)

.rule
Open(p, t) :- Task(p, t, l).
`,
      { grammarSource: 'e.dl' },
    )
    const r = resolveBackward(SRC, { Task: [] }, { rel: 'Open', row: ['a.md', 'milk'], insert: true }, PARSE)
    expect(r.status).toBe('refused')
    if (r.status !== 'refused') return
    expect(r.reason).toMatch(/l\b|unbound|does not determine/i)
  })

  it('refuses to choose between the rules of a multi-rule head', () => {
    const SRC = parseProgram(
      `\
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
`,
      { grammarSource: 'm.dl' },
    )
    const r = resolveBackward(SRC, { A: [], B: [] }, { rel: 'H', row: [1], insert: true }, PARSE)
    expect(r.status).toBe('refused')
    if (r.status !== 'refused') return
    expect(r.reason).toMatch(/which rule|several rules|ambiguous/i)
  })
})

describe('sessions', () => {
  it('insert commits and the view reflects it', () => {
    const s = openBackwardSession(COPY, PARSE)
    s.update('Item', [1, 'one'], 1)
    s.advance()
    const r = s.resolve({ rel: 'Named', row: [2, 'two'], insert: true })
    expect(r.status).toBe('ok')
    expect(s.rows('Named').some((x) => x[0] === 2)).toBe(true)
    expect(s.rows('Item').some((x) => x[0] === 2)).toBe(true)
    s.close()
  })
})
