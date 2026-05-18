// Integration tests: parse a .dl, run it end-to-end on synthetic facts,
// collect rows via the sink callback.
//
// These tests cover end-to-end execution paths: row-form projections,
// recursive transitive closure (reach.dl), inner joins via the smoke
// test, and head arithmetic. Aggregation isn't wired up yet.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Args, executeProgram, type IdbSink } from '../src/index.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-ts-executing-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFile(name: string, content: string): string {
  const filePath = path.join(tmpDir, name)
  fs.writeFileSync(filePath, content)
  return filePath
}

describe('executeProgram — reach.dl end-to-end (recursive)', () => {
  it('Reach is the transitive closure of Source under Arc', () => {
    const programPath = writeFile(
      'reach.dl',
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
    )
    // Source = {1}. Arc edges: 1→2, 2→3, 3→4. Reach should be {1,2,3,4}.
    writeFile('Source.csv', '1\n')
    writeFile('Arc.csv', '1,2\n2,3\n3,4\n')

    const args = new Args({ program: programPath, facts: tmpDir })
    const reach = new Set<bigint>()
    executeProgram(args, (rel, row, diff) => {
      if (rel !== 'Reach') return
      if (diff > 0) reach.add(row[0]!)
      else reach.delete(row[0]!)
    })
    expect([...reach].sort()).toEqual([1n, 2n, 3n, 4n])
  })
})

describe('executeProgram — non-recursive join', () => {
  it('Reach(z) :- Source(x), Arc(x, z) joins Source with Arc', () => {
    const programPath = writeFile(
      'oneStep.dl',
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
    )
    writeFile('Source.csv', '1\n2\n')
    writeFile('Arc.csv', '1,10\n2,20\n3,30\n')

    const seen: bigint[] = []
    executeProgram(new Args({ program: programPath, facts: tmpDir }), (rel, row) => {
      if (rel === 'Reach') seen.push(row[0]!)
    })

    expect(seen.sort()).toEqual([10n, 20n])
  })
})

describe('executeProgram — head arithmetic', () => {
  it('post-projects a head expression `x + 1`', () => {
    const programPath = writeFile(
      'addone.dl',
      `\
.in
.decl Source(id: number)
.input Source.csv

.printsize
.decl Plus1(id: number)

.rule
Plus1(x + 1) :- Source(x).
`,
    )
    writeFile('Source.csv', '1\n2\n3\n')

    const seen: bigint[] = []
    executeProgram(new Args({ program: programPath, facts: tmpDir }), (rel, row) => {
      if (rel === 'Plus1') seen.push(row[0]!)
    })

    expect(seen.sort()).toEqual([2n, 3n, 4n])
  })
})

describe('executeProgram — aggregation', () => {
  it('count() per group counts EDB rows', () => {
    const programPath = writeFile(
      'count.dl',
      `\
.in
.decl Arc(x: number, y: number)
.input Arc.csv

.printsize
.decl OutDeg(x: number, n: number)

.rule
OutDeg(x, count(y)) :- Arc(x, y).
`,
    )
    writeFile('Arc.csv', '1,10\n1,11\n1,12\n2,20\n3,30\n3,31\n')

    const seen = new Map<bigint, bigint>()
    executeProgram(new Args({ program: programPath, facts: tmpDir }), (rel, row) => {
      if (rel === 'OutDeg') seen.set(row[0]!, row[1]!)
    })

    expect(seen.get(1n)).toBe(3n)
    expect(seen.get(2n)).toBe(1n)
    expect(seen.get(3n)).toBe(2n)
  })

  it('sum() per group sums EDB rows', () => {
    const programPath = writeFile(
      'sum.dl',
      `\
.in
.decl W(x: number, w: number)
.input W.csv

.printsize
.decl Total(x: number, s: number)

.rule
Total(x, sum(w)) :- W(x, w).
`,
    )
    writeFile('W.csv', '1,5\n1,10\n2,7\n2,3\n2,1\n')

    const seen = new Map<bigint, bigint>()
    executeProgram(new Args({ program: programPath, facts: tmpDir }), (rel, row) => {
      if (rel === 'Total') seen.set(row[0]!, row[1]!)
    })
    expect(seen.get(1n)).toBe(15n)
    expect(seen.get(2n)).toBe(11n)
  })

  it('min() and max() per group', () => {
    const programPath = writeFile(
      'minmax.dl',
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
    )
    writeFile('W.csv', '1,5\n1,10\n1,1\n2,7\n2,3\n')

    const lo = new Map<bigint, bigint>()
    const hi = new Map<bigint, bigint>()
    executeProgram(new Args({ program: programPath, facts: tmpDir }), (rel, row) => {
      if (rel === 'Lo') lo.set(row[0]!, row[1]!)
      if (rel === 'Hi') hi.set(row[0]!, row[1]!)
    })
    expect(lo.get(1n)).toBe(1n)
    expect(lo.get(2n)).toBe(3n)
    expect(hi.get(1n)).toBe(10n)
    expect(hi.get(2n)).toBe(7n)
  })
})

describe('executeProgram — non-recursive single-rule projection', () => {
  it('Reach(y) :- Source(y). projects the EDB into the IDB', () => {
    // Trim the program down to just the non-recursive rule so this exercises
    // only what we've implemented so far.
    const programPath = writeFile(
      'reach1.dl',
      `\
.in
.decl Source(id: number)
.input Source.csv

.printsize
.decl Reach(id: number)

.rule
Reach(y) :- Source(y).
`,
    )
    writeFile('Source.csv', '1\n2\n3\n')

    const seen: Array<{ rel: string; row: readonly bigint[]; diff: number }> = []
    const sink: IdbSink = (rel, row, diff) => seen.push({ rel, row, diff })

    const args = new Args({ program: programPath, facts: tmpDir })
    executeProgram(args, sink)

    const reachRows = seen.filter((s) => s.rel === 'Reach').map((s) => s.row[0]!)
    expect(reachRows.sort()).toEqual([1n, 2n, 3n])
  })

  it('projects from a 2-column EDB to a 1-column IDB', () => {
    const programPath = writeFile(
      'proj.dl',
      `\
.in
.decl Arc(x: number, y: number)
.input Arc.csv

.printsize
.decl OnlyX(x: number)

.rule
OnlyX(x) :- Arc(x, y).
`,
    )
    writeFile('Arc.csv', '1,10\n2,20\n3,30\n')

    const seen: bigint[] = []
    executeProgram(new Args({ program: programPath, facts: tmpDir }), (rel, row) => {
      if (rel === 'OnlyX') seen.push(row[0]!)
    })

    expect(seen.sort()).toEqual([1n, 2n, 3n])
  })
})
