// Which columns of a view an edit can be written through.
//
// The compiler already decides this: it emits an update rule for a head column
// exactly when that column's variable traces to one position of one body atom.
// Reporting it costs nothing extra and saves every consumer from re-deriving
// it — flow-md has 100-odd lines doing precisely this analysis by hand.
//
// It is deliberately the *static* answer. A UI needs to know which inputs to
// make editable before it has a specific row in hand, and that question has no
// data in it. Whether a particular edit succeeds is a different question, and
// `resolveBackward` answers it exactly — a column reported here can still come
// back `ambiguous` or `unsatisfied` for a given row. Affordance from this,
// truth from the Resolution.

import { describe, expect, it } from 'vitest'
import { parseProgram } from '@flow-ts/parsing'
import { compileShadow } from '../../src/shadow/index.js'

const cols = (src: string, rel: string): number[] =>
  compileShadow(parseProgram(src, { grammarSource: 'w.dl' }), { views: 'all' })
    .writableColumns[rel] ?? []

describe('a column is writable when it traces to one source position', () => {
  it('a plain projection: every copied column', () => {
    expect(
      cols(
        `.in
.decl Task(p: string, s: string, t: string)
.input Task.csv
.printsize
.decl Open(p: string, t: string)
.rule
Open(p, t) :- Task(p, "open", t).`,
        'Open',
      ),
    ).toEqual([0, 1])
  })

  it('not a column that is joined on', () => {
    // `p` is the join key: rewriting it would have to change both sides at
    // once, which is a policy rather than an inference.
    expect(
      cols(
        `.in
.decl Task(id: number, p: number)
.input Task.csv
.decl Person(p: number, name: string)
.input Person.csv
.printsize
.decl Listed(p: number, name: string)
.rule
Listed(p, n) :- Task(i, p), Person(p, n).`,
        'Listed',
      ),
    ).toEqual([1])
  })

  it('not a column a filter also reads', () => {
    // The rewrite would have to keep the comparison true, which nothing here
    // guarantees.
    expect(
      cols(
        `.in
.decl R(a: number, b: number)
.input R.csv
.printsize
.decl S(a: number, b: number)
.rule
S(a, b) :- R(a, b), a < 10.`,
        'S',
      ),
    ).toEqual([1])
  })

  it('a computed column, when its arithmetic inverts', () => {
    expect(
      cols(
        `.in
.decl R(x: number)
.input R.csv
.printsize
.decl S(y: number)
.rule
S(x + 1) :- R(x).`,
        'S',
      ),
    ).toEqual([0])
  })

  it('not a computed column whose arithmetic does not invert', () => {
    expect(
      cols(
        `.in
.decl R(x: number)
.input R.csv
.printsize
.decl S(y: number)
.rule
S(x / 2) :- R(x).`,
        'S',
      ),
    ).toEqual([])
  })

  it('an aggregate column, once a policy says how to spread it', () => {
    const src = (put: string) => `.in
.decl Hours(p: string, w: number, h: number)
.input Hours.csv
.printsize
.decl Total(p: string, s: number)${put}
.rule
Total(p, sum(h)) :- Hours(p, w, h).`
    expect(cols(src(''), 'Total')).toEqual([])
    expect(cols(src('\n.put spread(min)'), 'Total')).toEqual([1])
  })

  it('nothing at all for a view marked read-only', () => {
    expect(
      cols(
        `.in
.decl Task(p: string, t: string)
.input Task.csv
.printsize
.decl Open(p: string, t: string)
.put none
.rule
Open(p, t) :- Task(p, t).`,
        'Open',
      ),
    ).toEqual([])
  })
})

describe('multi-rule heads report the optimistic union', () => {
  it('a column one rule can rewrite is reported, even if another cannot', () => {
    // `H(x) :- A(x, y).`  — x traces to one position, rewritable.
    // `H(x) :- B(x, x).`  — x occurs twice, so not through this rule.
    // A row derived only by the second will fail at resolve time, which is
    // exactly what the Resolution is for. Reporting the union keeps the
    // affordance available for rows that *can* be edited; the alternative
    // hides a working edit because some other row might not work.
    expect(
      cols(
        `.in
.decl A(x: number, y: number)
.input A.csv
.decl B(x: number, y: number)
.input B.csv
.printsize
.decl H(x: number)
.rule
H(x) :- A(x, y).
H(x) :- B(x, x).`,
        'H',
      ),
    ).toEqual([0])
  })
})

describe('it follows the scope it was compiled with', () => {
  const SRC = `.in
.decl Task(p: string, t: string)
.input Task.csv
.printsize
.decl Open(p: string, t: string)
.decl Other(p: string, t: string)
.rule
Open(p, t) :- Task(p, t).
Other(p, t) :- Task(p, t).`

  it('reports only views that were opted in', () => {
    const scoped = compileShadow(parseProgram(SRC, { grammarSource: 'w.dl' }), {
      views: ['Open'],
    })
    expect(Object.keys(scoped.writableColumns)).toEqual(['Open'])
  })

  it('and nothing when the update channel was switched off', () => {
    const noUpd = compileShadow(parseProgram(SRC, { grammarSource: 'w.dl' }), {
      views: 'all',
      channels: ['del'],
    })
    expect(noUpd.writableColumns).toEqual({})
  })
})
