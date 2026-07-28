// The update channel: rewriting one cell of a view.
//
// Del and Ins can express an update as a pair, but not *usefully* — nothing
// says which retraction goes with which insertion, and for an aggregate the
// two halves have to be solved together. A cell edit is its own request:
//
//   Upd_R(c0…cn-1, c0'…cn-1')     old row, then new row
//
// which is exactly the shape `plugin.updateFact(content, oldFact, newFact)`
// consumes in flow-md, so the engine's answer drops straight into the
// write-back path.
//
// Compilation is the same body replay as Del, with one twist: the *request*
// atom repeats the unchanged head variables, so a rule fires only for requests
// that touch its own column. `Upd_Open(p, t, p, t2)` matches "column 1 changed,
// column 0 didn't" structurally, in Datalog, with no side analysis.
//
// A head variable occurring more than once in the body is skipped: rewriting a
// value you joined on would have to change both sides at once, which is the
// join ambiguity and needs an annotation rather than an inference.

import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { parseProgram } from '@flow-ts/parsing'
import { compileShadow, resolveBackward } from '../../src/shadow/index.js'
import type { Row } from '../../src/reading/index.js'
import { type Facts, applyUpdates, backward, key, liveRows } from './_harness.js'

const PARSE = {
  parse: (src: string) => parseProgram(src, { grammarSource: 's.dl' }),
  views: 'all' as const,
}

function ruleLines(source: string): string[] {
  const at = source.indexOf('.rule')
  return source
    .slice(at + '.rule'.length)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

const PROJECTION = `\
.in
.decl Task(path: string, status: string, text: string, line: number)
.input Task.csv

.printsize
.decl Open(p: string, t: string)

.rule
Open(p, t) :- Task(p, "open", t, l).
`

describe('compilation', () => {
  it('rewrites the one body position a head column traces to', () => {
    const lines = ruleLines(compileShadow(parseProgram(PROJECTION)).source)
    // Column 1 (`t`) changed, column 0 (`p`) repeated ⇒ unchanged.
    expect(lines).toContain(
      'Upd_Task(p, "open", t, l, p, "open", t_n, l) :- Upd_Open(p, t, p, t_n), Task(p, "open", t, l).',
    )
    // Column 0 is equally rewritable — it also occurs exactly once.
    expect(lines).toContain(
      'Upd_Task(p, "open", t, l, p_n, "open", t, l) :- Upd_Open(p, t, p_n, t), Task(p, "open", t, l).',
    )
  })

  it('seeds the update channel', () => {
    const shadow = compileShadow(parseProgram(PROJECTION))
    expect(shadow.source).toContain('.decl SeedUpd_Open(')
    expect(ruleLines(shadow.source)).toContain(
      'Upd_Open(a0, a1, b0, b1) :- SeedUpd_Open(a0, a1, b0, b1).',
    )
  })

  it('skips a head variable that is joined on', () => {
    const lines = ruleLines(
      compileShadow(
        parseProgram(`\
.in
.decl Task(id: number, pid: number)
.input Task.csv
.decl Person(pid: number, name: string)
.input Person.csv

.printsize
.decl Assigned(pid: number, name: string)

.rule
Assigned(p, n) :- Task(i, p), Person(p, n).
`),
      ).source,
    )
    // `n` occurs once (in Person) so it is rewritable…
    expect(lines.some((l) => l.startsWith('Upd_Person('))).toBe(true)
    // …but `p` is the join variable, so nothing rewrites it.
    expect(lines.some((l) => l.startsWith('Upd_Task('))).toBe(false)
  })
})

describe('behaviour', () => {
  const FACTS: Facts = {
    Task: [
      ['a.md', 'open', 'milk', 3],
      ['a.md', 'open', 'bread', 7],
      ['b.md', 'closed', 'eggs', 1],
    ],
  }

  it('rewrites the source fact behind a view cell', () => {
    const { upd } = backward(PROJECTION, FACTS, 'Open', ['a.md', 'milk'], ['a.md', 'oat milk'])
    expect(upd.get('Task')).toBeDefined()
    expect([...upd.get('Task')!.values()]).toEqual([
      ['a.md', 'open', 'milk', 3, 'a.md', 'open', 'oat milk', 3],
    ])
  })

  it('the rewrite round-trips through the forward program', () => {
    const { upd } = backward(PROJECTION, FACTS, 'Open', ['a.md', 'milk'], ['a.md', 'oat milk'])
    const after = liveRows(PROJECTION, applyUpdates(FACTS, upd), 'Open')
    expect(after.has(key(['a.md', 'oat milk']))).toBe(true)
    expect(after.has(key(['a.md', 'milk']))).toBe(false)
    // Untouched rows stay untouched.
    expect(after.has(key(['a.md', 'bread']))).toBe(true)
  })

  it('a request for a row that is not derived yields nothing', () => {
    const { upd } = backward(PROJECTION, FACTS, 'Open', ['a.md', 'eggs'], ['a.md', 'x'])
    expect(upd.size).toBe(0)
  })

  it('recovers the projected-away column', () => {
    // `line` is nowhere in the view, yet the rewrite has to carry it.
    const { upd } = backward(PROJECTION, FACTS, 'Open', ['a.md', 'bread'], ['a.md', 'rye'])
    const [row] = [...upd.get('Task')!.values()]
    expect(row!.slice(0, 4)).toEqual(['a.md', 'open', 'bread', 7])
    expect(row!.slice(4)).toEqual(['a.md', 'open', 'rye', 7])
  })
})

describe('a rewrite is a proposal, not a guarantee', () => {
  // Found by the fuzzer, minimised. `a` occurs syntactically once, so the
  // compiler rewrites the position it traces to — but the *tuple* bound there
  // is also the tuple satisfying `E0(d, 1)`, and rewriting it destroys that
  // witness. Occurrence counting is syntactic; this conflict is semantic, and
  // no amount of static analysis of the rule text sees it: whether the two
  // atoms bind the same fact depends on the data.
  //
  // This is the concrete argument for the runtime protocol being
  // propose → apply → re-run → compare → commit or roll back. `put` only has
  // to be a good guess; the forward engine is what makes it safe.
  const SOURCE = `\
.in
.decl E0(a: number, b: number)
.input E0.csv

.printsize
.decl I0(d: number, a: number)

.rule
I0(d, a) :- E0(d, 1), E0(d, a).
`
  const FACTS: Facts = { E0: [[1, 1]] }

  it('proposes a sound rewrite', () => {
    expect(liveRows(SOURCE, FACTS, 'I0').has(key([1, 1]))).toBe(true)
    const { upd } = backward(SOURCE, FACTS, 'I0', [1, 1], [1, 9])
    // Sound: it starts from a fact that really exists.
    expect([...upd.get('E0')!.values()]).toEqual([[1, 1, 1, 9]])
  })

  it('…which does not achieve the request, because one tuple served two atoms', () => {
    const { upd } = backward(SOURCE, FACTS, 'I0', [1, 1], [1, 9])
    const after = liveRows(SOURCE, applyUpdates(FACTS, upd), 'I0')
    expect(after.has(key([1, 9]))).toBe(false)
    // The view is empty afterwards: E0(1, 1) is gone, so nothing derives.
    expect(after.size).toBe(0)
  })
})

describe('properties', () => {
  const name = fc.constantFrom('a', 'b', 'c', 'd')
  const factsGen = fc
    .array(
      fc.tuple(name, fc.constantFrom('open', 'closed'), name, fc.integer({ min: 0, max: 4 })),
      { minLength: 1, maxLength: 6 },
    )
    .map((rows) => {
      const seen = new Map<string, Row>()
      for (const r of rows) seen.set(r.join(''), [...r] as Row)
      return { Task: [...seen.values()] } as Facts
    })

  it('an update achieves the requested row and drops the old one', () => {
    let exercised = 0
    fc.assert(
      fc.property(factsGen, fc.nat(), name, (facts, pick, fresh) => {
        const view = [...liveRows(PROJECTION, facts, 'Open').values()]
        if (view.length === 0) return true
        const target = view[pick % view.length]!
        const next: Row = [target[0]!, `${fresh}~new`]

        const { upd } = backward(PROJECTION, facts, 'Open', target, next)
        if (upd.size === 0) return false
        exercised++

        const after = liveRows(PROJECTION, applyUpdates(facts, upd), 'Open')
        // The requested row is there…
        if (!after.has(key(next))) return false
        // …and the old one is gone. Every fact deriving the target is a
        // candidate, so they are all rewritten, not just one of them.
        return !after.has(key(target))
      }),
      { numRuns: 150 },
    )
    expect(exercised).toBeGreaterThan(30)
  })

  it('every proposed rewrite starts from a fact that exists', () => {
    fc.assert(
      fc.property(factsGen, fc.nat(), (facts, pick) => {
        const view = [...liveRows(PROJECTION, facts, 'Open').values()]
        if (view.length === 0) return true
        const target = view[pick % view.length]!
        const { upd } = backward(PROJECTION, facts, 'Open', target, [target[0]!, 'zzz'])
        const present = new Set(facts.Task!.map(key))
        for (const row of upd.get('Task')?.values() ?? []) {
          if (!present.has(key(row.slice(0, 4)))) return false
        }
        return true
      }),
      { numRuns: 150 },
    )
  })
})

describe('an unsatisfied rewrite says what it knocked out', () => {
  // "It didn't work" is true and unhelpful. The useful part is a step removed:
  // the tuple that was rewritten was holding up something *else*, and that
  // something else is what the row needed. Found by using the vault demo,
  // where demoting a `#` heading destroys the document title the row is filed
  // under — the message named neither the title nor the heading.
  const SOURCE = `\
.in
.decl H(path: string, depth: number, text: string)
.input H.csv

.printsize
.decl Doc(path: string, title: string)
.decl Outline(title: string, depth: number, text: string)

.rule
Doc(p, title) :- H(p, 1, title).
Outline(title, d, t) :- H(p, d, t), Doc(p, title).
`
  const PROGRAM = parseProgram(SOURCE, { grammarSource: 'o.dl' })
  const FACTS: Facts = { H: [['home.md', 1, 'Home'], ['home.md', 2, 'Chores']] }

  it('names the collateral row, not just the failure', () => {
    // Demoting the level-1 heading removes the only thing deriving `Doc`.
    const r = resolveBackward(
      PROGRAM,
      FACTS,
      { rel: 'Outline', row: ['Home', 1, 'Home'], newRow: ['Home', 2, 'Home'] },
      PARSE,
    )
    expect(r.status).toBe('unsatisfied')
    if (r.status !== 'unsatisfied') return
    expect(r.reason).toContain('Doc(home.md, Home)')
    expect(r.reason).toMatch(/holding up more than one thing/)
  })

  it('and the same edit on a heading that is not the title works', () => {
    const r = resolveBackward(
      PROGRAM,
      FACTS,
      { rel: 'Outline', row: ['Home', 2, 'Chores'], newRow: ['Home', 3, 'Chores'] },
      PARSE,
    )
    expect(r.status).toBe('ok')
  })
})
