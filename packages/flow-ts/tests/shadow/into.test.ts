// `.put into R` — naming which side of a join a write lands on.
//
// A rule body with several writable atoms produces several candidates, and the
// compiler refuses to choose. Usually that is right: the caller should be told.
// But the common case in a real vault is that one atom is the *subject* and the
// rest are lookups — a task joined against a project name, a note joined against
// its folder — and there the choice is a property of the schema, not of the
// request.
//
// This is Bancilhon & Spyratos' constant complement, named directly: the side
// you don't write is the thing held invariant, which is the classical condition
// under which a view update is well-defined and free of side effects.

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parseProgram } from '@flow-ts/parsing'
import type { Row } from '../../src/reading/index.js'
import { compileShadow, resolveBackward } from '../../src/shadow/index.js'
import { type Facts, applyDeletes, backward, key, liveRows } from './_harness.js'

const PARSE = { parse: (src: string) => parseProgram(src, { grammarSource: 's.dl' }), views: 'all' as const }

const src = (put: string) => `\
.in
.decl Task(id: number, pid: number, text: string)
.input Task.csv
.decl Project(pid: number, name: string)
.input Project.csv

.printsize
.decl Listed(id: number, text: string, name: string)${put}

.rule
Listed(i, t, n) :- Task(i, p, t), Project(p, n).
`

const PLAIN = src('')
const INTO = src('\n.put into Task')

const FACTS: Facts = {
  Task: [
    [1, 10, 'milk'],
    [2, 10, 'bread'],
  ],
  Project: [[10, 'home']],
}

function ruleLines(source: string): string[] {
  const at = source.indexOf('.rule')
  return source
    .slice(at + '.rule'.length)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

describe('parsing', () => {
  it('reads the target relation', () => {
    expect(parseProgram(INTO).idbs[0]!.put).toEqual({ kind: 'into', rel: 'Task' })
  })

  it('requires a relation name', () => {
    expect(() => parseProgram(src('\n.put into'))).toThrow()
  })

  it('round-trips', () => {
    expect(compileShadow(parseProgram(INTO)).source).toContain('.put into Task')
  })
})

describe('compilation', () => {
  it('without it, both sides are candidates', () => {
    const lines = ruleLines(compileShadow(parseProgram(PLAIN)).source)
    expect(lines.some((l) => l.startsWith('Del_Task('))).toBe(true)
    expect(lines.some((l) => l.startsWith('Del_Project('))).toBe(true)
  })

  it('with it, only the named side is', () => {
    const lines = ruleLines(compileShadow(parseProgram(INTO)).source)
    expect(lines.some((l) => l.startsWith('Del_Task('))).toBe(true)
    expect(lines.some((l) => l.startsWith('Del_Project('))).toBe(false)
    // The held-constant side is still replayed in the body — it is a lookup,
    // not something to ignore.
    expect(lines.find((l) => l.startsWith('Del_Task('))).toContain('Project(p, n)')
  })

  it('the update channel is restricted too', () => {
    const lines = ruleLines(compileShadow(parseProgram(INTO)).source)
    expect(lines.some((l) => l.startsWith('Upd_Task('))).toBe(true)
    expect(lines.some((l) => l.startsWith('Upd_Project('))).toBe(false)
  })

  it('refuses a relation the rule body does not mention', () => {
    const shadow = compileShadow(parseProgram(src('\n.put into Nope')))
    expect(shadow.refusals.some((r) => /Nope/.test(r.reason))).toBe(true)
  })
})

describe('behaviour', () => {
  it('turns an ambiguous request into an unambiguous one', () => {
    const opts = { ...PARSE, requireUnambiguous: true }
    expect(
      resolveBackward(parseProgram(PLAIN), FACTS, { rel: 'Listed', row: [1, 'milk', 'home'] }, opts)
        .status,
    ).toBe('ambiguous')
    expect(
      resolveBackward(parseProgram(INTO), FACTS, { rel: 'Listed', row: [1, 'milk', 'home'] }, opts)
        .status,
    ).toBe('ok')
  })

  it('holds the other side constant', () => {
    const r = resolveBackward(
      parseProgram(INTO),
      FACTS,
      { rel: 'Listed', row: [1, 'milk', 'home'] },
      PARSE,
    )
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.changes).toEqual([{ kind: 'del', rel: 'Task', row: [1, 10, 'milk'] }])
    // Project is untouched, so the sibling row survives — which is the point.
    expect(r.changes.some((c) => c.rel === 'Project')).toBe(false)
  })

  it('a rewrite lands on the named side', () => {
    const r = resolveBackward(
      parseProgram(INTO),
      FACTS,
      { rel: 'Listed', row: [1, 'milk', 'home'], newRow: [1, 'oat milk', 'home'] },
      PARSE,
    )
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.changes).toEqual([
      { kind: 'upd', rel: 'Task', row: [1, 10, 'milk'], newRow: [1, 10, 'oat milk'] },
    ])
  })

  it('refuses when the request only reaches the held-constant side', () => {
    // `name` comes from Project, which `into Task` excludes, so there is no
    // candidate rather than a silent write to the wrong relation.
    const r = resolveBackward(
      parseProgram(INTO),
      FACTS,
      { rel: 'Listed', row: [1, 'milk', 'home'], newRow: [1, 'milk', 'work'] },
      PARSE,
    )
    expect(r.status).toBe('refused')
  })
})

describe('properties', () => {
  const gen = fc
    .tuple(
      fc.uniqueArray(fc.integer({ min: 0, max: 6 }), { minLength: 1, maxLength: 5 }),
      fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 1, maxLength: 5 }),
    )
    .map(([ids, pids]) => ({
      Task: ids.map((i, k) => [i, pids[k % pids.length]!, `t${i}`] as Row),
      Project: [...new Set(pids)].map((p) => [p, `p${p}`] as Row),
    }))

  it('every proposal lands on the named relation and achieves the request', () => {
    let exercised = 0
    fc.assert(
      fc.property(gen, fc.nat(), (facts, pick) => {
        const view = [...liveRows(INTO, facts, 'Listed').values()]
        if (view.length === 0) return true
        const target = view[pick % view.length]!

        const { del } = backward(INTO, facts, 'Listed', target)
        for (const rel of del.keys()) if (rel !== 'Task') return false
        if (del.size === 0) return false
        exercised++

        const after = liveRows(INTO, applyDeletes(facts, del), 'Listed')
        // The row is gone, and every Project row survives untouched.
        return !after.has(key(target))
      }),
      { numRuns: 200 },
    )
    expect(exercised).toBeGreaterThan(50)
  })
})
