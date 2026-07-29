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


describe('and where each writable column lands', () => {
  // `writableColumns` answers "can this be written". A consumer that also
  // polices *what* may be written needs to know where it ends up — flow-md's
  // plugins declare writability per attribute, so a task's text can be
  // rewritten and the line it sits on cannot. That is a fact about the writer
  // rather than about the rules, so the engine cannot infer it; naming the
  // endpoint is what lets it be applied on top.
  const SRC = `\
.in
.decl MdNode(path: string, id: number, kind: string, line: number)
.input MdNode.csv
.decl MdText(path: string, id: number, text: string)
.input MdText.csv

.printsize
.decl Task()
.decl Open()
.decl Q()

.rule
Task(path, text, line) :- MdNode(path, id, "listItem", line), MdText(path, id, text).
Open(p, t) :- Task(p, t, l).
Q(path, text) :- Open(path, text).
`
  const targets = (views: string[]) =>
    compileShadow(parseProgram(SRC, { grammarSource: 'w.dl' }), { views }).writeTargets

  it('names the source relation and position, not the immediate one', () => {
    expect(targets(['Task'])['Task']?.[1]).toEqual([{ rel: 'MdText', column: 2 }])
    expect(targets(['Task'])['Task']?.[2]).toEqual([{ rel: 'MdNode', column: 3 }])
  })

  it('follows through as many rules as sit in between', () => {
    // Q over Open over Task over the EDB: three bodies before a source.
    expect(targets(['Q'])['Q']?.[1]).toEqual([{ rel: 'MdText', column: 2 }])
    expect(targets(['Open'])['Open']?.[1]).toEqual([{ rel: 'MdText', column: 2 }])
  })

  it('says nothing about a column with no update rule', () => {
    // `path` joins four positions, so it is not writable and has no endpoint.
    expect(targets(['Task'])['Task']?.[0]).toBeUndefined()
    expect(compileShadow(parseProgram(SRC, { grammarSource: 'w.dl' }), { views: ['Task'] })
      .writableColumns['Task']).not.toContain(0)
  })

  it('covers a column reached through an aggregate', () => {
    const AGG = `\
.in
.decl H(p: string, w: number, h: number)
.input H.csv

.printsize
.decl Total(p: string, s: number)
.put spread(min)

.rule
Total(p, sum(h)) :- H(p, w, h).
`
    const t = compileShadow(parseProgram(AGG, { grammarSource: 'a.dl' }), { views: ['Total'] })
    expect(t.writeTargets['Total']?.[1]).toEqual([{ rel: 'H', column: 2 }])
  })

  it('and one reached through arithmetic', () => {
    const ARITH = `\
.in
.decl H(p: string, h: number)
.input H.csv

.printsize
.decl Mins(p: string, m: number)

.rule
Mins(p, h * 60) :- H(p, h).
`
    const t = compileShadow(parseProgram(ARITH, { grammarSource: 'r.dl' }), { views: ['Mins'] })
    expect(t.writeTargets['Mins']?.[1]).toEqual([{ rel: 'H', column: 1 }])
  })

  it('reports every endpoint when several rules reach one column', () => {
    const MULTI = `\
.in
.decl A(x: number, y: number)
.input A.csv
.decl B(x: number, y: number)
.input B.csv

.printsize
.decl H(v: number)

.rule
H(y) :- A(x, y).
H(y) :- B(x, y).
`
    const t = compileShadow(parseProgram(MULTI, { grammarSource: 'm.dl' }), { views: ['H'] })
    expect(t.writeTargets['H']?.[0]).toEqual(
      expect.arrayContaining([
        { rel: 'A', column: 1 },
        { rel: 'B', column: 1 },
      ]),
    )
  })

  it('and terminates on a recursive view rather than chasing itself', () => {
    const REC = `\
.in
.decl Arc(x: number, y: number)
.input Arc.csv

.printsize
.decl T(x: number, y: number)

.rule
T(x, y) :- Arc(x, y).
T(x, z) :- T(x, y), Arc(y, z).
`
    const t = compileShadow(parseProgram(REC, { grammarSource: 'c.dl' }), { views: ['T'] })
    expect(t.writeTargets['T']?.[1]).toEqual(
      expect.arrayContaining([{ rel: 'Arc', column: 1 }]),
    )
  })
})
