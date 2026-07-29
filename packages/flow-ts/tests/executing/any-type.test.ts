// `any` columns, end to end.
//
// The claim being tested is that `any` is a *declaration* and not a special
// case: a column declared `any` joins, filters, negates, aggregates and
// recurses exactly as a typed one does, because the runtime never consulted
// the declared type in the first place — it keys on the encoded row, and the
// encoding tags each field with its own type.
//
// So most of these tests are really testing that nothing happens. The ones
// that matter are the two edges: a numeric string is not the number it looks
// like, and an operation that genuinely needs a number still says so when it
// doesn't get one.

import { describe, expect, it } from 'vitest'
import { parseProgram } from '@flow-ts/parsing'
import { executeProgram } from '../../src/executing/index.js'
import type { Row } from '../../src/reading/index.js'

/** Run a program and net the diffs, so a row retracted within the run doesn't
 *  show up in the answer. */
function run(source: string, edbs: Record<string, Row[]>): Map<string, string[]> {
  const net = new Map<string, Map<string, number>>()
  executeProgram(
    parseProgram(source, { grammarSource: 'any.dl' }),
    new Map(Object.entries(edbs)),
    {},
    (rel, row, diff) => {
      let bucket = net.get(rel)
      if (!bucket) net.set(rel, (bucket = new Map()))
      const key = row.map((v) => `${typeof v === 'string' ? 's' : 'n'}:${v}`).join('|')
      bucket.set(key, (bucket.get(key) ?? 0) + diff)
    },
  )
  const out = new Map<string, string[]>()
  for (const [rel, bucket] of net) {
    out.set(rel, [...bucket].filter(([, n]) => n > 0).map(([k]) => k).sort())
  }
  return out
}

describe('a column that holds both kinds', () => {
  const SOURCE = `\
.in
.decl Prop(entity: string, key: string, value: any)

.out
.decl Value(v: any)
.decl OfAge(entity: string, v: any)

Value(v) :- Prop(e, k, v).
OfAge(e, v) :- Prop(e, "age", v).
`
  const FACTS = {
    Prop: [
      ['alice', 'age', 34],
      ['alice', 'city', 'Oslo'],
      ['bob', 'age', 17],
      ['bob', 'city', 'Bergen'],
      ['carol', 'age', 'unknown'],
    ] as Row[],
  }

  it('carries numbers and strings through the same column', () => {
    expect(run(SOURCE, FACTS).get('Value')).toEqual([
      'n:17',
      'n:34',
      's:Bergen',
      's:Oslo',
      's:unknown',
    ])
  })

  it('keeps the JS type of each cell, rather than stringifying', () => {
    expect(run(SOURCE, FACTS).get('OfAge')).toEqual(['s:alice|n:34', 's:bob|n:17', 's:carol|s:unknown'])
  })
})

describe('joining on an untyped column', () => {
  // The join key is the encoded field, and `any` encodes exactly as the
  // concrete codecs do — so an `any` column joins a typed one with no
  // conversion anywhere.
  const SOURCE = `\
.in
.decl Ref(from: string, target: any)
.decl Page(id: number, title: string)
.decl Tag(slug: string, label: string)

.out
.decl ToPage(from: string, title: string)
.decl ToTag(from: string, label: string)

ToPage(f, t) :- Ref(f, id), Page(id, t).
ToTag(f, l) :- Ref(f, slug), Tag(slug, l).
`
  const FACTS = {
    Ref: [
      ['a', 1],
      ['b', 'intro'],
      ['c', 2],
      // Looks like page 1, but it is the *string* "1".
      ['d', '1'],
    ] as Row[],
    Page: [
      [1, 'Home'],
      [2, 'About'],
    ] as Row[],
    Tag: [['intro', 'Introduction']] as Row[],
  }

  it('joins the numeric cells against a number column', () => {
    expect(run(SOURCE, FACTS).get('ToPage')).toEqual(['s:a|s:Home', 's:c|s:About'])
  })

  it('joins the string cells against a string column', () => {
    expect(run(SOURCE, FACTS).get('ToTag')).toEqual(['s:b|s:Introduction'])
  })

  it('does not confuse the string "1" with the number 1', () => {
    // The whole reason the wire format tags fields. `d` matches nothing.
    expect(run(SOURCE, FACTS).get('ToPage')).not.toContain('s:d|s:Home')
  })
})

describe('the rest of the language is unaffected', () => {
  it('filters, negates and recurses over an untyped column', () => {
    const out = run(
      `\
.in
.decl Edge(from: any, to: any)
.decl Blocked(node: any)

.out
.decl Reach(from: any, to: any)
.decl Open(from: any, to: any)
.decl Big(from: any)

Reach(a, b) :- Edge(a, b).
Reach(a, c) :- Reach(a, b), Edge(b, c).
Open(a, b) :- Reach(a, b), !Blocked(b).
Big(a) :- Edge(a, b), a > 10.
`,
      {
        // A graph whose node ids are numbers in one half and slugs in the other.
        Edge: [
          [1, 2],
          [2, 'sink'],
          ['root', 1],
          [42, 'sink'],
        ],
        Blocked: [['sink']],
      },
    )
    expect(out.get('Reach')).toEqual([
      'n:1|n:2',
      'n:1|s:sink',
      'n:2|s:sink',
      'n:42|s:sink',
      's:root|n:1',
      's:root|n:2',
      's:root|s:sink',
    ])
    // Everything reachable except the blocked node.
    expect(out.get('Open')).toEqual(['n:1|n:2', 's:root|n:1', 's:root|n:2'])
    // A comparison over an `any` column compares the values it actually finds.
    expect(out.get('Big')).toEqual(['n:42'])
  })

  it('counts an untyped column, whatever is in it', () => {
    const out = run(
      `\
.in
.decl Prop(entity: string, value: any)

.out
.decl Props(entity: string, n: number)

Props(e, count(v)) :- Prop(e, v).
`,
      {
        Prop: [
          ['alice', 34],
          ['alice', 'Oslo'],
          ['bob', 17],
        ],
      },
    )
    expect(out.get('Props')).toEqual(['s:alice|n:2', 's:bob|n:1'])
  })
})

describe('operations that need a number still need one', () => {
  // `any` widens what a column may hold, not what arithmetic accepts. The
  // failure is at runtime and by value, because that is the only place the
  // answer is known — and it names the problem rather than coercing.
  const ARITH = `\
.in
.decl Reading(sensor: string, value: any)

.out
.decl Doubled(sensor: string, v: any)

Doubled(s, v * 2) :- Reading(s, v).
`

  it('computes when the value is numeric', () => {
    expect(run(ARITH, { Reading: [['a', 21]] }).get('Doubled')).toEqual(['s:a|n:42'])
  })

  it('throws, saying what it got, when it is not', () => {
    expect(() => run(ARITH, { Reading: [['a', 'hot']] })).toThrow(/non-numeric/)
  })

  it('refuses to sum a column holding a string', () => {
    expect(() =>
      run(
        `\
.in
.decl Reading(sensor: string, value: any)

.out
.decl Total(sensor: string, v: any)

Total(s, sum(v)) :- Reading(s, v).
`,
        { Reading: [['a', 1], ['a', 'hot']] },
      ),
    ).toThrow(/non-numeric/)
  })
})
