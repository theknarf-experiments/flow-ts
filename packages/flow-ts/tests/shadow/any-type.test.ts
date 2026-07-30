// Writing back through a column declared `any`.
//
// The backward direction is compiled *as Datalog*: the shadow program is
// emitted as source and parsed again. So every column type it touches has to
// survive being written out and read back — a type the serializer can't emit,
// or the grammar can't accept, is a type the write-back path silently cannot
// carry. `any` is the newest one, and this is where that shows up.
//
// The interesting case is a rewrite that changes a cell's *kind*: 34 → "secret"
// is a legal edit of an `any` column and an illegal one of a typed column, and
// nothing in the shadow compiler had to learn that — the declaration says it.

import { describe, expect, it } from 'vitest'
import { parseProgram } from '../../src/parsing/index.js'
import { compileShadow, openBackwardSession } from '../../src/shadow/index.js'
import { type Facts, backward, liveRows } from './_harness.js'

const SOURCE = `\
.in
.decl Prop(entity: string, key: string, value: any)
.input Prop.csv

.printsize
.decl Age(entity: string, value: any)
.put insert defaults(k = "age")

.rule
Age(e, v) :- Prop(e, "age", v).
`

const FACTS: Facts = {
  Prop: [
    ['alice', 'age', 34],
    ['bob', 'age', 'unknown'],
    ['alice', 'city', 'Oslo'],
  ],
}

describe('the compiled shadow program', () => {
  it('re-emits `any` so the generated source parses back', () => {
    const shadow = compileShadow(parseProgram(SOURCE), { views: ['Age'] })
    expect(shadow.refusals).toEqual([])
    expect(shadow.source).toContain('value: any')
    expect(() => parseProgram(shadow.source, { grammarSource: 's.dl' })).not.toThrow()
  })

  it('makes both columns writable, like any other traceable projection', () => {
    const shadow = compileShadow(parseProgram(SOURCE), { views: ['Age'] })
    expect(shadow.writableColumns.Age).toEqual([0, 1])
  })
})

describe('rewriting an untyped cell', () => {
  it('lands on the fact, recovering the key the view dropped', () => {
    const { upd } = backward(SOURCE, FACTS, 'Age', ['alice', 34], ['alice', 35], {
      views: ['Age'],
    })
    expect([...(upd.get('Prop')?.values() ?? [])]).toEqual([
      ['alice', 'age', 34, 'alice', 'age', 35],
    ])
  })

  it('can change the cell from a number to a string', () => {
    // The edit a typed column would have to refuse. Here it is just an edit.
    const { upd } = backward(SOURCE, FACTS, 'Age', ['alice', 34], ['alice', 'secret'], {
      views: ['Age'],
    })
    expect([...(upd.get('Prop')?.values() ?? [])]).toEqual([
      ['alice', 'age', 34, 'alice', 'age', 'secret'],
    ])
  })

  it('and from a string to a number', () => {
    const { upd } = backward(SOURCE, FACTS, 'Age', ['bob', 'unknown'], ['bob', 18], {
      views: ['Age'],
    })
    expect([...(upd.get('Prop')?.values() ?? [])]).toEqual([
      ['bob', 'age', 'unknown', 'bob', 'age', 18],
    ])
  })

  it('does not confuse a numeric string with the number it looks like', () => {
    // `Age(alice, "34")` is not a derived row — the fact holds the number — so
    // there is nothing to rewrite and the request finds no candidate.
    const { upd } = backward(SOURCE, FACTS, 'Age', ['alice', '34'], ['alice', 35], {
      views: ['Age'],
    })
    expect(upd.get('Prop')).toBeUndefined()
  })
})

describe('the other channels', () => {
  it('deletes the fact behind an untyped row', () => {
    const { del } = backward(SOURCE, FACTS, 'Age', ['bob', 'unknown'], undefined, {
      views: ['Age'],
    })
    expect([...(del.get('Prop')?.values() ?? [])]).toEqual([['bob', 'age', 'unknown']])
  })

  // The insert channel has no harness helper, so this goes through the public
  // session API — which is the path a consumer actually takes anyway.
  it('inserts one, taking the dropped key from the default', () => {
    const session = openBackwardSession(parseProgram(SOURCE), {
      views: ['Age'],
      parse: (src) => parseProgram(src, { grammarSource: 'shadow.dl' }),
    })
    for (const row of FACTS.Prop!) session.update('Prop', row, +1)
    session.advance()

    const numeric = session.resolve({ rel: 'Age', row: ['carol', 9], insert: true }, { commit: false })
    expect(numeric.status).toBe('ok')
    expect(numeric.status === 'ok' && numeric.changes).toEqual([
      { kind: 'ins', rel: 'Prop', row: ['carol', 'age', 9] },
    ])

    // …and a string in the same column, which is the point of declaring it.
    const textual = session.resolve(
      { rel: 'Age', row: ['dave', 'declined'], insert: true },
      { commit: false },
    )
    expect(textual.status === 'ok' && textual.changes).toEqual([
      { kind: 'ins', rel: 'Prop', row: ['dave', 'age', 'declined'] },
    ])
  })
})

describe('the forward direction still agrees', () => {
  it('derives exactly the age rows, of whichever kind', () => {
    const rows = [...liveRows(SOURCE, FACTS, 'Age').values()].sort((a, b) =>
      String(a[0]).localeCompare(String(b[0])),
    )
    expect(rows).toEqual([
      ['alice', 34],
      ['bob', 'unknown'],
    ])
  })
})
