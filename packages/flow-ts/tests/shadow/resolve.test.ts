// The runtime protocol: propose → apply → re-run → compare → commit or reject.
//
// Every incompleteness found so far is of the same kind. `put` proposes a
// change that really did support the row, and applying it still doesn't
// achieve the request:
//
//   • negation — retracting the supporting fact unblocks a second derivation
//     (properties.test.ts, `negation re-derives`);
//   • aliasing — one tuple satisfies two body atoms, so rewriting it for one
//     destroys the other's witness (update.test.ts).
//
// Neither is visible in the rule text; both depend on the data. So the
// compiler is not where this gets fixed. `resolveBackward` runs the forward
// program on the proposed facts and compares, which turns "sound but maybe
// incomplete" into "correct or explicitly rejected". That check is affordable
// precisely because the engine is incremental.

import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { parseProgram } from '../../src/parsing/index.js'
import type { Row } from '../../src/reading/index.js'
import { resolveBackward } from '../../src/shadow/index.js'

type Facts = Record<string, Row[]>

const prog = (src: string) => parseProgram(src, { grammarSource: 'r.dl' })
/** flow-ts has no parser dependency, so the reader is injected. */
const P = { parse: (src: string) => parseProgram(src, { grammarSource: 'shadow.dl' }), views: 'all' as const }

const PROJECTION = prog(`\
.in
.decl Task(path: string, status: string, text: string, line: number)
.input Task.csv

.printsize
.decl Open(p: string, t: string)

.rule
Open(p, t) :- Task(p, "open", t, l).
`)

const TASKS: Facts = {
  Task: [
    ['a.md', 'open', 'milk', 3],
    ['a.md', 'open', 'bread', 7],
    ['b.md', 'closed', 'eggs', 1],
  ],
}

describe('delete', () => {
  it('resolves to the source fact and verifies it', () => {
    const r = resolveBackward(PROJECTION, TASKS, { rel: 'Open', row: ['a.md', 'milk'] }, P)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.changes).toEqual([
      { kind: 'del', rel: 'Task', row: ['a.md', 'open', 'milk', 3] },
    ])
    expect(r.rounds).toBe(1)
  })

  it('refuses a row the program does not derive', () => {
    const r = resolveBackward(PROJECTION, TASKS, { rel: 'Open', row: ['a.md', 'eggs'] }, P)
    expect(r.status).toBe('refused')
    if (r.status !== 'refused') return
    expect(r.reason).toMatch(/not derived|no candidate/i)
  })

  it('refuses an unknown relation rather than silently doing nothing', () => {
    const r = resolveBackward(PROJECTION, TASKS, { rel: 'Nope', row: ['x'] }, P)
    expect(r.status).toBe('refused')
  })

  it('iterates when negation makes one pass insufficient', () => {
    const SOURCE = prog(`\
.in
.decl E0(a: number, b: number, c: number)
.input E0.csv

.printsize
.decl I0(a: number)

.rule
I0(a) :- E0(a, d, b), !E0(a, a, d).
`)
    const r = resolveBackward(SOURCE, { E0: [[0, 0, 1], [0, 1, 1]] }, { rel: 'I0', row: [0] }, P)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    // One pass proposes a sound but insufficient change; the protocol notices.
    expect(r.rounds).toBeGreaterThan(1)
  })
})

describe('update', () => {
  it('resolves a cell edit to a source rewrite', () => {
    const r = resolveBackward(PROJECTION, TASKS, {
      rel: 'Open',
      row: ['a.md', 'milk'],
      newRow: ['a.md', 'oat milk'],
    }, P)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.changes).toEqual([
      {
        kind: 'upd',
        rel: 'Task',
        row: ['a.md', 'open', 'milk', 3],
        newRow: ['a.md', 'open', 'oat milk', 3],
      },
    ])
  })

  it('rejects an edit that does not achieve the request', () => {
    // One tuple serves two atoms; rewriting it destroys the other witness.
    const SOURCE = prog(`\
.in
.decl E0(a: number, b: number)
.input E0.csv

.printsize
.decl I0(d: number, a: number)

.rule
I0(d, a) :- E0(d, 1), E0(d, a).
`)
    const r = resolveBackward(SOURCE, { E0: [[1, 1]] }, {
      rel: 'I0',
      row: [1, 1],
      newRow: [1, 9],
    }, P)
    expect(r.status).toBe('unsatisfied')
    if (r.status !== 'unsatisfied') return
    // The caller gets the proposal that was rejected, for reporting.
    expect(r.attempted.length).toBeGreaterThan(0)
    expect(r.reason).toMatch(/did not/i)
  })
})

describe('ambiguity is reported, not guessed', () => {
  const JOIN = prog(`\
.in
.decl Task(id: number, pid: number)
.input Task.csv
.decl Person(pid: number, name: string)
.input Person.csv

.printsize
.decl Assigned(id: number, name: string)

.rule
Assigned(i, n) :- Task(i, p), Person(p, n).
`)
  const FACTS: Facts = { Task: [[1, 10]], Person: [[10, 'ann']] }

  it('surfaces both sides of a join as candidates', () => {
    const r = resolveBackward(JOIN, FACTS, { rel: 'Assigned', row: [1, 'ann'] }, {
      ...P,
      requireUnambiguous: true,
    })
    expect(r.status).toBe('ambiguous')
    if (r.status !== 'ambiguous') return
    expect(new Set(r.candidates.map((c) => c.rel))).toEqual(new Set(['Task', 'Person']))
  })

  it('applies all of them when the caller allows it', () => {
    const r = resolveBackward(JOIN, FACTS, { rel: 'Assigned', row: [1, 'ann'] }, P)
    expect(r.status).toBe('ok')
  })
})

describe('a flow-md-shaped program', () => {
  // This is what `vault.ts` assembles: plugin rules, plus one synthetic rule
  // per query block whose head is a hash-named relation declared with no
  // attributes, since the arity is left to the rule. Every such view used to be
  // unseedable, which put the whole backward path out of reach from a vault.
  const VAULT = prog(`\
.in
.decl MdNode(path: string, id: number, kind: string, line: number)
.input MdNode.csv
.decl MdNodeText(path: string, id: number, text: string)
.input MdNodeText.csv

.printsize
.decl Task(path: string, status: string, text: string, line: number)
.decl Qa1b2c3()

.rule
Task(p, "open", t, l) :- MdNode(p, i, "task-open", l), MdNodeText(p, i, t).
Qa1b2c3(p, t) :- Task(p, "open", t, l).
`)

  const VAULT_FACTS: Facts = {
    MdNode: [
      ['todo.md', 1, 'task-open', 3],
      ['todo.md', 2, 'task-open', 7],
    ],
    MdNodeText: [
      ['todo.md', 1, 'buy milk'],
      ['todo.md', 2, 'water plants'],
    ],
  }

  it('the untyped query view is seedable', () => {
    const r = resolveBackward(VAULT, VAULT_FACTS, { rel: 'Qa1b2c3', row: ['todo.md', 'buy milk'] }, P)
    expect(r.status).toBe('ok')
  })

  it('an edit resolves through two rules to the owning source facts', () => {
    const r = resolveBackward(
      VAULT,
      VAULT_FACTS,
      {
        rel: 'Qa1b2c3',
        row: ['todo.md', 'buy milk'],
        newRow: ['todo.md', 'buy oat milk'],
      },
      P,
    )
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    // The rewrite lands on the text node, not on the tree node — `text` occurs
    // once, in MdNodeText, and the walk found it through the Task rule.
    expect(r.changes).toEqual([
      {
        kind: 'upd',
        rel: 'MdNodeText',
        row: ['todo.md', 1, 'buy milk'],
        newRow: ['todo.md', 1, 'buy oat milk'],
      },
    ])
  })

  it('still refuses a request that names the wrong types', () => {
    const r = resolveBackward(VAULT, VAULT_FACTS, { rel: 'Qa1b2c3', row: [1, 2] }, P)
    expect(r.status).toBe('refused')
    if (r.status !== 'refused') return
    expect(r.reason).toMatch(/column 0 expects string/i)
  })
})

describe('properties', () => {
  const name = fc.constantFrom('a', 'b', 'c')
  const factsGen = fc
    .array(
      fc.tuple(name, fc.constantFrom('open', 'closed'), name, fc.integer({ min: 0, max: 3 })),
      { minLength: 1, maxLength: 6 },
    )
    .map((rows) => {
      const seen = new Map<string, Row>()
      for (const r of rows) seen.set(r.join(''), [...r] as Row)
      return { Task: [...seen.values()] } as Facts
    })

  it('never reports ok without the request actually holding', () => {
    let ok = 0
    fc.assert(
      fc.property(factsGen, fc.nat(), fc.boolean(), (facts, pick, asUpdate) => {
        const view = liveOpen(facts)
        if (view.length === 0) return true
        const target = view[pick % view.length]!
        const req = asUpdate
          ? { rel: 'Open', row: target, newRow: [target[0]!, 'renamed'] as Row }
          : { rel: 'Open', row: target }

        const r = resolveBackward(PROJECTION, facts, req, P)
        if (r.status !== 'ok') return true
        ok++
        // Verify independently of the implementation's own check.
        const after = liveOpen(applyAll(facts, r.changes))
        const has = (row: Row) => after.some((x) => x[0] === row[0] && x[1] === row[1])
        return asUpdate ? has(req.newRow as Row) : !has(target)
      }),
      { numRuns: 200 },
    )
    expect(ok).toBeGreaterThan(50)
  })
})

// --- local helpers ----------------------------------------------------------

function liveOpen(facts: Facts): Row[] {
  const seen = new Map<string, Row>()
  for (const t of facts.Task ?? []) {
    if (t[1] === 'open') seen.set(`${t[0]}${t[2]}`, [t[0]!, t[2]!])
  }
  return [...seen.values()]
}

function applyAll(
  facts: Facts,
  changes: ReadonlyArray<{ kind: string; rel: string; row: Row; newRow?: Row }>,
): Facts {
  const k = (r: Row) => r.join('')
  const out: Facts = { ...facts }
  for (const c of changes) {
    const rows = out[c.rel] ?? []
    if (c.kind === 'del') out[c.rel] = rows.filter((r) => k(r) !== k(c.row))
    else if (c.kind === 'ins') out[c.rel] = [...rows, c.row]
    else out[c.rel] = rows.map((r) => (k(r) === k(c.row) ? c.newRow! : r))
  }
  return out
}
