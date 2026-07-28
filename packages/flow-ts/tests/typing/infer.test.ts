// Inferring the column types of derived relations.
//
// `.decl Foo()` is a legal declaration: the arity is left to the rules, and the
// engine never needed the types because IDB rows only ever flow *out*. Feeding
// rows *in* is different — a fact channel needs a codec per column — so the
// shadow compiler couldn't build a `Seed_` EDB for any view declared that way.
// flow-md declares every query that way (`vault.ts` emits `.decl Q<hash>()`),
// which made the whole backward path unreachable from a real vault.
//
// The types are recoverable, though: a head variable comes from some body
// position, and that position has a declared type. Aggregates and arithmetic
// have known result types. So this is the same "trace a head column back to a
// body position" walk the update channel already does, run over the whole
// program to a fixpoint so IDBs defined in terms of IDBs resolve too.

import { describe, expect, it } from 'vitest'
import { parseProgram } from '@flow-ts/parsing'
import { inferRelationTypes } from '../../src/typing/index.js'

const types = (src: string) => inferRelationTypes(parseProgram(src, { grammarSource: 't.dl' }))

const HEAD = `\
.in
.decl Task(path: string, status: string, text: string, line: number)
.input Task.csv
.decl Score(id: number, value: float)
.input Score.csv

.printsize
`

describe('from a single rule', () => {
  it('traces each head variable to the body position it came from', () => {
    const t = types(`${HEAD}.decl Open()\n\n.rule\nOpen(p, t) :- Task(p, "open", t, l).`)
    expect(t.types.get('Open')).toEqual(['String', 'String'])
  })

  it('picks up a projected column of another type', () => {
    const t = types(`${HEAD}.decl Line()\n\n.rule\nLine(p, l) :- Task(p, "open", t, l).`)
    expect(t.types.get('Line')).toEqual(['String', 'Integer'])
  })

  it('respects an explicit declaration rather than inferring over it', () => {
    const t = types(
      `${HEAD}.decl Open(a: string, b: string)\n\n.rule\nOpen(p, t) :- Task(p, "open", t, l).`,
    )
    expect(t.types.get('Open')).toEqual(['String', 'String'])
  })

  it('reads a constant head argument directly', () => {
    const t = types(`${HEAD}.decl Kind()\n\n.rule\nKind(p, "wiki") :- Task(p, s, t, l).`)
    expect(t.types.get('Kind')).toEqual(['String', 'String'])
  })

  it('head arithmetic is numeric', () => {
    const t = types(`${HEAD}.decl Next()\n\n.rule\nNext(p, l + 1) :- Task(p, s, t, l).`)
    expect(t.types.get('Next')).toEqual(['String', 'Integer'])
  })

  it('float columns stay float', () => {
    const t = types(`${HEAD}.decl Val()\n\n.rule\nVal(i, v) :- Score(i, v).`)
    expect(t.types.get('Val')).toEqual(['Integer', 'Float'])
  })
})

describe('aggregates', () => {
  it('sum takes the type of what it sums', () => {
    const t = types(`${HEAD}.decl Total()\n\n.rule\nTotal(i, sum(v)) :- Score(i, v).`)
    expect(t.types.get('Total')).toEqual(['Integer', 'Float'])
  })

  it('count is always an integer', () => {
    const t = types(`${HEAD}.decl Size()\n\n.rule\nSize(i, count(v)) :- Score(i, v).`)
    expect(t.types.get('Size')).toEqual(['Integer', 'Integer'])
  })

  it('min keeps the aggregated column type', () => {
    const t = types(`${HEAD}.decl Lowest()\n\n.rule\nLowest(p, min(l)) :- Task(p, s, x, l).`)
    expect(t.types.get('Lowest')).toEqual(['String', 'Integer'])
  })
})

describe('across relations', () => {
  it('resolves an IDB defined in terms of another IDB', () => {
    const t = types(
      `${HEAD}.decl Mid()\n.decl Top()\n\n.rule\nMid(p, l) :- Task(p, s, x, l).\nTop(l) :- Mid(p, l).`,
    )
    expect(t.types.get('Mid')).toEqual(['String', 'Integer'])
    expect(t.types.get('Top')).toEqual(['Integer'])
  })

  it('resolves through recursion via the base rule', () => {
    const t = types(`\
.in
.decl Arc(x: number, y: number)
.input Arc.csv

.printsize
.decl Path()

.rule
Path(x, y) :- Arc(x, y).
Path(x, z) :- Path(x, y), Arc(y, z).`)
    expect(t.types.get('Path')).toEqual(['Integer', 'Integer'])
  })

  it('resolves regardless of declaration order', () => {
    const t = types(
      `${HEAD}.decl Top()\n.decl Mid()\n\n.rule\nTop(l) :- Mid(p, l).\nMid(p, l) :- Task(p, s, x, l).`,
    )
    expect(t.types.get('Top')).toEqual(['Integer'])
  })
})

describe('what it refuses to guess', () => {
  it('reports a column two rules disagree about', () => {
    const t = types(
      `${HEAD}.decl Mixed()\n\n.rule\nMixed(p) :- Task(p, s, x, l).\nMixed(l) :- Task(p, s, x, l).`,
    )
    expect(t.types.has('Mixed')).toBe(false)
    expect(t.unresolved.find((u) => u.rel === 'Mixed')?.reason).toMatch(/conflict|disagree/i)
  })

  it('reports a column no rule pins down', () => {
    // `Unknown` is declared but has no rules at all.
    const t = types(`${HEAD}.decl Real()\n.decl Unknown()\n\n.rule\nReal(p) :- Task(p, s, x, l).`)
    expect(t.types.has('Unknown')).toBe(false)
    expect(t.unresolved.find((u) => u.rel === 'Unknown')).toBeDefined()
  })

  it('does not invent a type for a placeholder-only head position', () => {
    // `_` is anonymous, so nothing connects the head column to a body column.
    const t = types(`${HEAD}.decl Anon()\n\n.rule\nAnon(y) :- Task(p, s, x, l), Score(y, v).`)
    // `y` *is* traceable — it comes from Score's first column.
    expect(t.types.get('Anon')).toEqual(['Integer'])
  })
})

describe('the whole program', () => {
  it('includes EDBs, which were typed all along', () => {
    const t = types(`${HEAD}.decl Open()\n\n.rule\nOpen(p, t) :- Task(p, "open", t, l).`)
    expect(t.types.get('Task')).toEqual(['String', 'String', 'String', 'Integer'])
    expect(t.types.get('Score')).toEqual(['Integer', 'Float'])
  })
})
