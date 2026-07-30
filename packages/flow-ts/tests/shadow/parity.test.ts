// One request, two entry points, one answer.
//
// `resolveBackward` and `openBackwardSession().resolve` used to be separate
// implementations of the same protocol — propose, apply, verify, minimise,
// commit or roll back — and they drifted exactly as two copies of anything do.
// Every improvement to a message landed on one side: a session reported a
// truncated inverse as an aliasing conflict long after the one-shot had learnt
// to name the row it produced instead, and reported a view declared
// `.put none` as though nothing had been found rather than as a decision.
//
// The one-shot is a wrapper now, so parity is structural rather than
// maintained. This is here to notice if that stops being true, and it is worth
// checking the *messages* and not just the statuses: the statuses agreed the
// whole time it was wrong.

import { describe, expect, it } from 'vitest'
import { parseProgram } from '../../src/parsing/index.js'
import type { Row } from '../../src/reading/index.js'
import {
  type BackwardRequest,
  type Resolution,
  openBackwardSession,
  resolveBackward,
} from '../../src/shadow/index.js'

const parse = (src: string) => parseProgram(src, { grammarSource: 's.dl' })
type Facts = Record<string, Row[]>

/** The same request, both ways. */
function both(
  src: string,
  facts: Facts,
  request: BackwardRequest,
  options: { minimize?: boolean; requireUnambiguous?: boolean } = {},
): { cold: Resolution; warm: Resolution } {
  const program = parseProgram(src, { grammarSource: 'g.dl' })
  const shared = { parse, views: [request.rel], ...options }
  const cold = resolveBackward(program, facts, request, shared)

  const session = openBackwardSession(program, shared)
  for (const [rel, rows] of Object.entries(facts)) {
    for (const row of rows) session.update(rel, row, 1)
  }
  session.advance()
  const warm = session.resolve(request)
  session.close()
  return { cold, warm }
}

/** Status and reason together — comparing statuses alone would have passed
 *  throughout the period this was broken. */
const describeIt = (r: Resolution): string =>
  r.status === 'ok'
    ? `ok: ${r.changes.map((c) => `${c.kind} ${c.rel}(${c.row.join(',')})`).sort().join(' | ')}`
    : `${r.status}: ${(r as { reason: string }).reason}`

const agree = (src: string, facts: Facts, request: BackwardRequest, options = {}) => {
  const { cold, warm } = both(src, facts, request, options)
  expect(describeIt(warm)).toBe(describeIt(cold))
  return cold
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
const TASKS: Facts = {
  Task: [
    ['a.md', 'open', 'milk', 3],
    ['a.md', 'open', 'bread', 7],
    ['b.md', 'closed', 'eggs', 1],
  ],
}

describe('the two entry points give the same answer', () => {
  it('for a delete', () => {
    const r = agree(PROJECTION, TASKS, { rel: 'Open', row: ['a.md', 'milk'] })
    expect(r.status).toBe('ok')
  })

  it('for a rewrite', () => {
    const r = agree(PROJECTION, TASKS, {
      rel: 'Open',
      row: ['a.md', 'milk'],
      newRow: ['a.md', 'oat milk'],
    })
    expect(r.status).toBe('ok')
  })

  it('for an insert', () => {
    agree(PROJECTION, TASKS, { rel: 'Open', row: ['c.md', 'rye'], insert: true })
  })

  it('for a row that is not derived', () => {
    const r = agree(PROJECTION, TASKS, { rel: 'Open', row: ['a.md', 'eggs'] })
    expect(r.status).toBe('refused')
  })

  it('with minimisation on', () => {
    const PATH = `\
.in
.decl Arc(x: number, y: number)
.input Arc.csv

.printsize
.decl Path(x: number, y: number)

.rule
Path(x, y) :- Arc(x, y).
Path(x, z) :- Path(x, y), Arc(y, z).
`
    // Recursive, cyclic, and minimised: the search applies and reverts
    // candidates repeatedly, which is where the two paths differ most in how
    // they get to the answer.
    const r = agree(PATH, { Arc: [[0, 1], [1, 2], [2, 1]] }, { rel: 'Path', row: [0, 2] }, {
      minimize: true,
    })
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.changes).toHaveLength(1)
  })

  it('when the request is ambiguous', () => {
    const JOIN = `\
.in
.decl A(x: number)
.input A.csv
.decl B(x: number)
.input B.csv

.printsize
.decl H(x: number)

.rule
H(x) :- A(x), B(x).
`
    const r = agree(JOIN, { A: [[1]], B: [[1]] }, { rel: 'H', row: [1] }, {
      requireUnambiguous: true,
    })
    expect(r.status).toBe('ambiguous')
  })
})

describe('and the same reason when they refuse', () => {
  // Each of these was reported differently by the two paths at some point.
  it('a view the schema declared read-only', () => {
    const r = agree(
      `\
.in
.decl H(p: string, w: number, h: number)
.input H.csv

.printsize
.decl Total(p: string, s: number)
.put none

.rule
Total(p, sum(h)) :- H(p, w, h).
`,
      { H: [['x', 1, 5]] },
      { rel: 'Total', row: ['x', 5], newRow: ['x', 9] },
    )
    expect(r.status).toBe('refused')
    if (r.status !== 'refused') return
    expect(r.reason).toContain('.put none')
  })

  it('an aggregate with no policy to invert it', () => {
    const r = agree(
      `\
.in
.decl H(p: string, w: number, h: number)
.input H.csv

.printsize
.decl Total(p: string, s: number)

.rule
Total(p, sum(h)) :- H(p, w, h).
`,
      { H: [['x', 1, 5]] },
      { rel: 'Total', row: ['x', 5], newRow: ['x', 9] },
    )
    expect(r.status).toBe('refused')
    if (r.status !== 'refused') return
    expect(r.reason).toMatch(/aggregation/)
  })

  it('an inverse that does not round-trip', () => {
    const r = agree(
      `\
.in
.decl R(x: number)
.input R.csv

.printsize
.decl S(y: number)

.rule
S(x * 60) :- R(x).
`,
      { R: [[3]] },
      { rel: 'S', row: [180], newRow: [150] },
    )
    expect(r.status).toBe('unsatisfied')
    if (r.status !== 'unsatisfied') return
    expect(r.reason).toContain('does not round-trip')
  })

  it('a tuple that was serving two atoms at once', () => {
    const r = agree(
      `\
.in
.decl E0(a: number, b: number)
.input E0.csv

.printsize
.decl I0(d: number, a: number)

.rule
I0(d, a) :- E0(d, 1), E0(d, a).
`,
      { E0: [[1, 1]] },
      { rel: 'I0', row: [1, 1], newRow: [1, 9] },
    )
    expect(r.status).toBe('unsatisfied')
  })

  it('a channel the caller did not compile', () => {
    const program = parseProgram(PROJECTION, { grammarSource: 'g.dl' })
    const shared = { parse, views: ['Open'], channels: ['upd'] as const }
    const cold = resolveBackward(program, TASKS, { rel: 'Open', row: ['a.md', 'milk'] }, shared)
    const session = openBackwardSession(program, shared)
    for (const row of TASKS.Task!) session.update('Task', row, 1)
    session.advance()
    const warm = session.resolve({ rel: 'Open', row: ['a.md', 'milk'] })
    session.close()
    expect(describeIt(warm)).toBe(describeIt(cold))
    expect(cold.status).toBe('refused')
  })

  it('a malformed request', () => {
    const r = agree(PROJECTION, TASKS, { rel: 'Open', row: [1, 2] })
    expect(r.status).toBe('refused')
    if (r.status !== 'refused') return
    expect(r.reason).toMatch(/expects string/i)
  })
})

describe('the one-shot keeps nothing', () => {
  it('does not touch the facts it was handed', () => {
    const facts: Facts = { Task: TASKS.Task!.map((r) => [...r]) }
    const before = JSON.stringify(facts)
    const r = resolveBackward(
      parseProgram(PROJECTION, { grammarSource: 'g.dl' }),
      facts,
      { rel: 'Open', row: ['a.md', 'milk'] },
      { parse, views: ['Open'] },
    )
    expect(r.status).toBe('ok')
    // The changes come back as data for the caller to apply wherever the facts
    // came from — a file, a database. Applying them here as well would
    // double-count, so the session that computed them is closed and discarded.
    expect(JSON.stringify(facts)).toBe(before)
  })

  it('and answers the same way twice', () => {
    const facts: Facts = { Task: TASKS.Task!.map((r) => [...r]) }
    const ask = () =>
      resolveBackward(
        parseProgram(PROJECTION, { grammarSource: 'g.dl' }),
        facts,
        { rel: 'Open', row: ['a.md', 'milk'] },
        { parse, views: ['Open'] },
      )
    expect(describeIt(ask())).toBe(describeIt(ask()))
  })
})
