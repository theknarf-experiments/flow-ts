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
    const reach = new Set<bigint>()
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
        Source: [[1n]],
        Arc: [[1n, 2n], [2n, 3n], [3n, 4n]],
      },
      (rel, row, diff) => {
        if (rel !== 'Reach') return
        if (diff > 0) reach.add(row[0]!)
        else reach.delete(row[0]!)
      },
    )
    expect([...reach].sort()).toEqual([1n, 2n, 3n, 4n])
  })
})

describe('executeProgram — non-recursive join', () => {
  it('Reach(z) :- Source(x), Arc(x, z) joins Source with Arc', () => {
    const seen: bigint[] = []
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
        Source: [[1n], [2n]],
        Arc: [[1n, 10n], [2n, 20n], [3n, 30n]],
      },
      (rel, row) => {
        if (rel === 'Reach') seen.push(row[0]!)
      },
    )
    expect(seen.sort()).toEqual([10n, 20n])
  })
})

describe('executeProgram — head arithmetic', () => {
  it('post-projects a head expression `x + 1`', () => {
    const seen: bigint[] = []
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
      { Source: [[1n], [2n], [3n]] },
      (rel, row) => {
        if (rel === 'Plus1') seen.push(row[0]!)
      },
    )
    expect(seen.sort()).toEqual([2n, 3n, 4n])
  })
})

describe('executeProgram — aggregation', () => {
  it('count() per group counts EDB rows', () => {
    const seen = new Map<bigint, bigint>()
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
          [1n, 10n], [1n, 11n], [1n, 12n],
          [2n, 20n],
          [3n, 30n], [3n, 31n],
        ],
      },
      (rel, row) => {
        if (rel === 'OutDeg') seen.set(row[0]!, row[1]!)
      },
    )
    expect(seen.get(1n)).toBe(3n)
    expect(seen.get(2n)).toBe(1n)
    expect(seen.get(3n)).toBe(2n)
  })

  it('sum() per group sums EDB rows', () => {
    const seen = new Map<bigint, bigint>()
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
        W: [[1n, 5n], [1n, 10n], [2n, 7n], [2n, 3n], [2n, 1n]],
      },
      (rel, row) => {
        if (rel === 'Total') seen.set(row[0]!, row[1]!)
      },
    )
    expect(seen.get(1n)).toBe(15n)
    expect(seen.get(2n)).toBe(11n)
  })

  it('min() and max() per group', () => {
    const lo = new Map<bigint, bigint>()
    const hi = new Map<bigint, bigint>()
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
        W: [[1n, 5n], [1n, 10n], [1n, 1n], [2n, 7n], [2n, 3n]],
      },
      (rel, row) => {
        if (rel === 'Lo') lo.set(row[0]!, row[1]!)
        if (rel === 'Hi') hi.set(row[0]!, row[1]!)
      },
    )
    expect(lo.get(1n)).toBe(1n)
    expect(lo.get(2n)).toBe(3n)
    expect(hi.get(1n)).toBe(10n)
    expect(hi.get(2n)).toBe(7n)
  })
})

describe('executeProgram — non-recursive single-rule projection', () => {
  it('Reach(y) :- Source(y). projects the EDB into the IDB', () => {
    const seen: Array<{ rel: string; row: readonly bigint[]; diff: number }> = []
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
      { Source: [[1n], [2n], [3n]] },
      sink,
    )
    const reachRows = seen.filter((s) => s.rel === 'Reach').map((s) => s.row[0]!)
    expect(reachRows.sort()).toEqual([1n, 2n, 3n])
  })

  it('projects from a 2-column EDB to a 1-column IDB', () => {
    const seen: bigint[] = []
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
      { Arc: [[1n, 10n], [2n, 20n], [3n, 30n]] },
      (rel, row) => {
        if (rel === 'OnlyX') seen.push(row[0]!)
      },
    )
    expect(seen.sort()).toEqual([1n, 2n, 3n])
  })
})
