// Tests for `runInspect`. We drive it with a synthetic line sink and
// assert on the structure of the output (text mode) and the JSON shape.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runInspect } from '../src/inspect.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-ts-inspect-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(name: string, content: string): string {
  const p = path.join(tmpDir, name)
  fs.writeFileSync(p, content)
  return p
}

const REACH = `\
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
`

const CC = `\
.in
.decl Arc(x: number, y: number)
.input Arc.csv

.printsize
.decl CC(node: number, cc: number)

.rule
CC(node, min(node)) :- Arc(node, _).
CC(node, min(cc)) :- Arc(other, node), CC(other, cc).
`

function capture(programPath: string, options = {}): string[] {
  const lines: string[] = []
  runInspect(programPath, options, (l) => lines.push(l))
  return lines
}

describe('runInspect (text)', () => {
  it('reports the parsed program, strata, and plan for reach.dl', () => {
    const out = capture(write('reach.dl', REACH))
    const joined = out.join('\n')

    expect(joined).toContain('EDBs (2):')
    expect(joined).toContain('Source(id: number)')
    expect(joined).toContain('Arc(x: number, y: number)')
    expect(joined).toContain('IDBs (1):')
    expect(joined).toContain('Reach(id: number)')

    expect(joined).toContain('Rules (2):')
    expect(joined).toContain('[0] Reach(y) :- Source(y).')

    expect(joined).toContain('Strata')
    // reach.dl: two strata, one non-recursive base case, one recursive step.
    expect(joined).toMatch(/#0 non-recursive/)
    expect(joined).toMatch(/#1 recursive/)

    expect(joined).toContain('Plan')
    expect(joined).toContain('Heads: Reach')

    // No aggregations in reach.dl.
    expect(joined).toContain('Aggregation catalog (0):')
  })

  it('lists aggregation entries for cc.dl', () => {
    const out = capture(write('cc.dl', CC))
    const joined = out.join('\n')
    expect(joined).toMatch(/Aggregation catalog \(1\):/)
    expect(joined).toMatch(/CC: min\(/)
  })
})

describe('runInspect (json)', () => {
  it('emits a structured object', () => {
    const out = capture(write('reach.dl', REACH), { json: true })
    const parsed = JSON.parse(out.join('\n')) as {
      program: { edbs: string[]; idbs: string[]; rules: string[] }
      strata: Array<{ recursive: boolean; rules: string[] }>
      plan: Array<{ heads: string[] }>
      aggregations: Array<{ relation: string }>
    }
    expect(parsed.program.edbs).toHaveLength(2)
    expect(parsed.program.idbs).toEqual(['Reach(id: number)'])
    expect(parsed.program.rules).toHaveLength(2)
    expect(parsed.strata).toHaveLength(2)
    expect(parsed.strata[0]!.recursive).toBe(false)
    expect(parsed.strata[1]!.recursive).toBe(true)
    expect(parsed.plan.flatMap((s) => s.heads)).toContain('Reach')
    expect(parsed.aggregations).toEqual([])
  })
})

describe('runInspect — planner knobs', () => {
  it('honours noSharing in the plan', () => {
    const a = capture(write('a.dl', REACH))
    const b = capture(write('b.dl', REACH), { noSharing: true })
    // The plan output for reach.dl is small enough that both forms
    // produce visibly different transformation counts when sharing
    // is toggled. The point of this test isn't to assert on the
    // exact count — just that the knob plumbs through to the planner.
    expect(a.join('\n')).not.toBe(b.join('\n'))
  })
})
