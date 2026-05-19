// Integration tests: parse a .dl program inline, run it against in-memory
// EDB facts, and collect rows via the sink callback. No filesystem.

import { describe, expect, it } from 'vitest'
import { parseProgram } from '@flow-ts/parsing'
import type { Row } from '@flow-ts/reading'
import { executeProgram, type IdbSink } from '../src/index.js'

function run(source: string, edbs: Record<string, Row[]>, sink: IdbSink): void {
  const program = parseProgram(source, { grammarSource: 'inline' })
  executeProgram(program, new Map(Object.entries(edbs)), {}, sink)
}

describe('executeProgram — reach.dl end-to-end (recursive)', () => {
  it('Reach is the transitive closure of Source under Arc', () => {
    const reach = new Set<number>()
    run(
      `\
.in
.decl Source(id: number)
.input Source.csv

.decl Arc(x: number, y: number)
.input Arc.csv

.printsize
.decl Reach(id: number)

.rule
Reach(y) :- Source(y).
Reach(y) :- Reach(x), Arc(x, y).
`,
      {
        Source: [[1]],
        Arc: [[1, 2], [2, 3], [3, 4]],
      },
      (rel, row, diff) => {
        if (rel !== 'Reach') return
        if (diff > 0) reach.add(row[0]!)
        else reach.delete(row[0]!)
      },
    )
    expect([...reach].sort()).toEqual([1, 2, 3, 4])
  })
})

describe('executeProgram — non-recursive join', () => {
  it('Reach(z) :- Source(x), Arc(x, z) joins Source with Arc', () => {
    const seen: number[] = []
    run(
      `\
.in
.decl Source(id: number)
.input Source.csv

.decl Arc(x: number, y: number)
.input Arc.csv

.printsize
.decl Reach(id: number)

.rule
Reach(y) :- Source(x), Arc(x, y).
`,
      {
        Source: [[1], [2]],
        Arc: [[1, 10], [2, 20], [3, 30]],
      },
      (rel, row) => {
        if (rel === 'Reach') seen.push(row[0]!)
      },
    )
    expect(seen.sort()).toEqual([10, 20])
  })
})

describe('executeProgram — head arithmetic', () => {
  it('post-projects a head expression `x + 1`', () => {
    const seen: number[] = []
    run(
      `\
.in
.decl Source(id: number)
.input Source.csv

.printsize
.decl Plus1(id: number)

.rule
Plus1(x + 1) :- Source(x).
`,
      { Source: [[1], [2], [3]] },
      (rel, row) => {
        if (rel === 'Plus1') seen.push(row[0]!)
      },
    )
    expect(seen.sort()).toEqual([2, 3, 4])
  })
})

describe('executeProgram — aggregation', () => {
  it('count() per group counts EDB rows', () => {
    const seen = new Map<number, number>()
    run(
      `\
.in
.decl Arc(x: number, y: number)
.input Arc.csv

.printsize
.decl OutDeg(x: number, n: number)

.rule
OutDeg(x, count(y)) :- Arc(x, y).
`,
      {
        Arc: [
          [1, 10], [1, 11], [1, 12],
          [2, 20],
          [3, 30], [3, 31],
        ],
      },
      (rel, row) => {
        if (rel === 'OutDeg') seen.set(row[0]!, row[1]!)
      },
    )
    expect(seen.get(1)).toBe(3)
    expect(seen.get(2)).toBe(1)
    expect(seen.get(3)).toBe(2)
  })

  it('sum() per group sums EDB rows', () => {
    const seen = new Map<number, number>()
    run(
      `\
.in
.decl W(x: number, w: number)
.input W.csv

.printsize
.decl Total(x: number, s: number)

.rule
Total(x, sum(w)) :- W(x, w).
`,
      {
        W: [[1, 5], [1, 10], [2, 7], [2, 3], [2, 1]],
      },
      (rel, row) => {
        if (rel === 'Total') seen.set(row[0]!, row[1]!)
      },
    )
    expect(seen.get(1)).toBe(15)
    expect(seen.get(2)).toBe(11)
  })

  it('min() and max() per group', () => {
    const lo = new Map<number, number>()
    const hi = new Map<number, number>()
    run(
      `\
.in
.decl W(x: number, w: number)
.input W.csv

.printsize
.decl Lo(x: number, m: number)
.decl Hi(x: number, m: number)

.rule
Lo(x, min(w)) :- W(x, w).
Hi(x, max(w)) :- W(x, w).
`,
      {
        W: [[1, 5], [1, 10], [1, 1], [2, 7], [2, 3]],
      },
      (rel, row) => {
        if (rel === 'Lo') lo.set(row[0]!, row[1]!)
        if (rel === 'Hi') hi.set(row[0]!, row[1]!)
      },
    )
    expect(lo.get(1)).toBe(1)
    expect(lo.get(2)).toBe(3)
    expect(hi.get(1)).toBe(10)
    expect(hi.get(2)).toBe(7)
  })
})

describe('executeProgram — non-recursive single-rule projection', () => {
  it('Reach(y) :- Source(y). projects the EDB into the IDB', () => {
    const seen: Array<{ rel: string; row: readonly number[]; diff: number }> = []
    const sink: IdbSink = (rel, row, diff) => seen.push({ rel, row, diff })
    run(
      `\
.in
.decl Source(id: number)
.input Source.csv

.printsize
.decl Reach(id: number)

.rule
Reach(y) :- Source(y).
`,
      { Source: [[1], [2], [3]] },
      sink,
    )
    const reachRows = seen.filter((s) => s.rel === 'Reach').map((s) => s.row[0]!)
    expect(reachRows.sort()).toEqual([1, 2, 3])
  })

  it('projects from a 2-column EDB to a 1-column IDB', () => {
    const seen: number[] = []
    run(
      `\
.in
.decl Arc(x: number, y: number)
.input Arc.csv

.printsize
.decl OnlyX(x: number)

.rule
OnlyX(x) :- Arc(x, y).
`,
      { Arc: [[1, 10], [2, 20], [3, 30]] },
      (rel, row) => {
        if (rel === 'OnlyX') seen.push(row[0]!)
      },
    )
    expect(seen.sort()).toEqual([1, 2, 3])
  })
})
