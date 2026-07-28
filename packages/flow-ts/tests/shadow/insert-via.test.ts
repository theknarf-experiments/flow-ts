// `.put insert via R` — choosing which rule an insertion satisfies.
//
// Deletion through a multi-rule head is mechanical: killing a disjunction means
// killing every disjunct, so all rules fire. Insertion is the opposite. Only one
// disjunct has to hold, and nothing in the program says which — so the compiler
// refuses rather than picking the first rule and hoping.
//
// The choice is a property of the schema, like `.put into R` is for joins, so it
// is written the same way: name a relation, and the rule whose body mentions it
// is the one an insert satisfies. Naming a relation that several rules mention,
// or none, is a refusal with a reason rather than a guess.

import { describe, expect, it } from 'vitest'
import { parseProgram } from '@flow-ts/parsing'
import type { Row } from '../../src/reading/index.js'
import { compileShadow, resolveBackward } from '../../src/shadow/index.js'
import { type Facts, key, liveRows } from './_harness.js'

const PARSE = { parse: (src: string) => parseProgram(src, { grammarSource: 's.dl' }) }

const src = (put: string) => `\
.in
.decl Draft(id: number, text: string)
.input Draft.csv
.decl Published(id: number, text: string)
.input Published.csv

.printsize
.decl Note(id: number, text: string)${put}

.rule
Note(i, t) :- Draft(i, t).
Note(i, t) :- Published(i, t).
`

const PLAIN = src('')
const VIA_DRAFT = src('\n.put insert via Draft')

const FACTS: Facts = { Draft: [[1, 'one']], Published: [] }

function ruleLines(source: string): string[] {
  const at = source.indexOf('.rule')
  return source
    .slice(at + '.rule'.length)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

const applyChanges = (
  facts: Facts,
  changes: ReadonlyArray<{ kind: string; rel: string; row: Row }>,
): Facts => {
  const out: Facts = { ...facts }
  for (const c of changes) {
    const rows = out[c.rel] ?? []
    if (c.kind === 'ins') out[c.rel] = [...rows, c.row]
    else if (c.kind === 'del') out[c.rel] = rows.filter((r) => key(r) !== key(c.row))
  }
  return out
}

describe('parsing', () => {
  it('reads the target relation', () => {
    expect(parseProgram(VIA_DRAFT).idbs[0]!.put).toEqual({
      kind: 'insert',
      via: 'Draft',
      defaults: [],
    })
  })

  it('round-trips', () => {
    expect(compileShadow(parseProgram(VIA_DRAFT)).source).toContain('.put insert via Draft')
  })
})

describe('compilation', () => {
  it('without it, insertion is refused for a multi-rule head', () => {
    const shadow = compileShadow(parseProgram(PLAIN))
    expect(shadow.refusals.some((r) => /several rules/i.test(r.reason))).toBe(true)
    expect(ruleLines(shadow.source).some((l) => l.startsWith('Ins_Draft('))).toBe(false)
  })

  it('with it, only the named rule contributes', () => {
    const lines = ruleLines(compileShadow(parseProgram(VIA_DRAFT)).source)
    expect(lines).toContain('Ins_Draft(i, t) :- Ins_Note(i, t).')
    expect(lines.some((l) => l.startsWith('Ins_Published('))).toBe(false)
  })

  it('deletion still fans out over every rule — that part was never ambiguous', () => {
    const lines = ruleLines(compileShadow(parseProgram(VIA_DRAFT)).source)
    expect(lines).toContain('Del_Draft(i, t) :- Del_Note(i, t), Draft(i, t).')
    expect(lines).toContain('Del_Published(i, t) :- Del_Note(i, t), Published(i, t).')
  })

  it('refuses a relation no rule mentions', () => {
    const shadow = compileShadow(parseProgram(src('\n.put insert via Nope')))
    expect(shadow.refusals.some((r) => /Nope/.test(r.reason))).toBe(true)
  })

  it('refuses a relation several rules mention', () => {
    const shadow = compileShadow(
      parseProgram(`\
.in
.decl A(x: number)
.input A.csv

.printsize
.decl H(x: number)
.put insert via A

.rule
H(x) :- A(x).
H(x) :- A(x), A(x).
`),
    )
    expect(shadow.refusals.some((r) => /several rules mention|more than one rule/i.test(r.reason)))
      .toBe(true)
  })
})

describe('behaviour', () => {
  it('inserts into the named side', () => {
    const r = resolveBackward(
      parseProgram(VIA_DRAFT),
      FACTS,
      { rel: 'Note', row: [2, 'two'], insert: true },
      PARSE,
    )
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.changes).toEqual([{ kind: 'ins', rel: 'Draft', row: [2, 'two'] }])
    expect(liveRows(VIA_DRAFT, applyChanges(FACTS, r.changes), 'Note').has(key([2, 'two']))).toBe(
      true,
    )
  })

  it('without the annotation it refuses, and says what to write', () => {
    const r = resolveBackward(
      parseProgram(PLAIN),
      FACTS,
      { rel: 'Note', row: [2, 'two'], insert: true },
      PARSE,
    )
    expect(r.status).toBe('refused')
    if (r.status !== 'refused') return
    expect(r.reason).toMatch(/insert via/i)
  })

  it('deleting still removes the row from both sides', () => {
    const facts: Facts = { Draft: [[1, 'one']], Published: [[1, 'one']] }
    const r = resolveBackward(
      parseProgram(VIA_DRAFT),
      facts,
      { rel: 'Note', row: [1, 'one'] },
      PARSE,
    )
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(new Set(r.changes.map((c) => c.rel))).toEqual(new Set(['Draft', 'Published']))
  })
})
