// `.put insert defaults(...)` — values for what the head doesn't carry.
//
// `Open(p, t) :- Task(p, t, l).` can be deleted and rewritten through, because
// both only ever ask about a row that already exists and `l` comes back from
// replaying the body. Inserting is different: there is no existing row, so `l`
// has no value and nothing in the program suggests one.
//
// flow-md solves this by convention — its /insert endpoint takes locator
// columns as 0 and lets the reparse fill in the truth. That convention is a
// property of the schema, so it belongs next to it:
//
//   .put insert defaults(l = 0)
//
// It composes with `via`, since a multi-rule head can need both.

import { describe, expect, it } from 'vitest'
import { parseProgram } from '../../src/parsing/index.js'
import type { Row } from '../../src/reading/index.js'
import { compileShadow, resolveBackward } from '../../src/shadow/index.js'
import { type Facts, key, liveRows } from './_harness.js'

const PARSE = { parse: (src: string) => parseProgram(src, { grammarSource: 's.dl' }), views: 'all' as const }

const src = (put: string) => `\
.in
.decl Task(p: string, t: string, l: number)
.input Task.csv

.printsize
.decl Open(p: string, t: string)${put}

.rule
Open(p, t) :- Task(p, t, l).
`

const PLAIN = src('')
const WITH_DEFAULT = src('\n.put insert defaults(l = 0)')

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
  it('reads one default', () => {
    expect(parseProgram(WITH_DEFAULT).idbs[0]!.put).toEqual({
      kind: 'insert',
      via: null,
      defaults: [['l', { kind: 'Integer', value: 0 }]],
    })
  })

  it('reads several, of mixed types', () => {
    const p = parseProgram(src('\n.put insert defaults(l = 0, k = "x")'))
    expect(p.idbs[0]!.put).toEqual({
      kind: 'insert',
      via: null,
      defaults: [
        ['l', { kind: 'Integer', value: 0 }],
        ['k', { kind: 'Text', value: 'x' }],
      ],
    })
  })

  it('composes with via', () => {
    const p = parseProgram(src('\n.put insert via Task defaults(l = 0)'))
    expect(p.idbs[0]!.put).toEqual({
      kind: 'insert',
      via: 'Task',
      defaults: [['l', { kind: 'Integer', value: 0 }]],
    })
  })

  it('round-trips', () => {
    expect(compileShadow(parseProgram(WITH_DEFAULT)).source).toContain(
      '.put insert defaults(l = 0)',
    )
    expect(compileShadow(parseProgram(src('\n.put insert via Task defaults(l = 0)'))).source)
      .toContain('.put insert via Task defaults(l = 0)')
  })
})

describe('compilation', () => {
  it('without it, insertion is refused and names the variable', () => {
    const shadow = compileShadow(parseProgram(PLAIN))
    expect(shadow.refusals.some((r) => /"l"/.test(r.reason))).toBe(true)
    expect(ruleLines(shadow.source).some((l) => l.startsWith('Ins_Task('))).toBe(false)
  })

  it('with it, the default is substituted', () => {
    const lines = ruleLines(compileShadow(parseProgram(WITH_DEFAULT)).source)
    expect(lines).toContain('Ins_Task(p, t, 0) :- Ins_Open(p, t).')
  })

  it('still refuses a variable no default covers', () => {
    const shadow = compileShadow(
      parseProgram(`\
.in
.decl Task(p: string, t: string, l: number, m: number)
.input Task.csv

.printsize
.decl Open(p: string, t: string)
.put insert defaults(l = 0)

.rule
Open(p, t) :- Task(p, t, l, m).
`),
    )
    expect(shadow.refusals.some((r) => /"m"/.test(r.reason))).toBe(true)
  })
})

describe('behaviour', () => {
  const FACTS: Facts = { Task: [['a.md', 'milk', 3]] }

  it('inserts the source fact with the default filled in', () => {
    const r = resolveBackward(
      parseProgram(WITH_DEFAULT),
      FACTS,
      { rel: 'Open', row: ['a.md', 'bread'], insert: true },
      PARSE,
    )
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.changes).toEqual([{ kind: 'ins', rel: 'Task', row: ['a.md', 'bread', 0] }])
    expect(
      liveRows(WITH_DEFAULT, applyChanges(FACTS, r.changes), 'Open').has(key(['a.md', 'bread'])),
    ).toBe(true)
  })

  it('deleting and rewriting are unaffected — they never needed the default', () => {
    const del = resolveBackward(
      parseProgram(WITH_DEFAULT),
      FACTS,
      { rel: 'Open', row: ['a.md', 'milk'] },
      PARSE,
    )
    expect(del.status).toBe('ok')
    if (del.status === 'ok') {
      // The real line comes back from the body replay, not from the default.
      expect(del.changes).toEqual([{ kind: 'del', rel: 'Task', row: ['a.md', 'milk', 3] }])
    }

    const upd = resolveBackward(
      parseProgram(WITH_DEFAULT),
      FACTS,
      { rel: 'Open', row: ['a.md', 'milk'], newRow: ['a.md', 'oat milk'] },
      PARSE,
    )
    expect(upd.status).toBe('ok')
    if (upd.status === 'ok') {
      expect(upd.changes[0]!.newRow).toEqual(['a.md', 'oat milk', 3])
    }
  })
})
