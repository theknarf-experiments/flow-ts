// `?-` query rules, past the parser.
//
// The shorthand desugars to `.decl Q()` plus the rule, so the claim these tests
// exist to check is that there is nothing else to it: a query relation plans,
// executes, recurses, gets its types inferred and can be written back through,
// exactly as a declared one does. If any stage had to learn about queries, the
// desugaring would be the wrong design and one of these would fail.

import { describe, expect, it } from 'vitest'
import { parseProgram } from '@flow-ts/parsing'
import { executeProgram } from '../../src/executing/index.js'
import type { Row } from '../../src/reading/index.js'
import { inferRelationTypes } from '../../src/typing/index.js'
import { compileShadow, openBackwardSession } from '../../src/shadow/index.js'

const EDB = `\
.in
.decl Person(id: number, name: string, dept: string)
.decl Salary(id: number, amount: number)
`

const FACTS: Record<string, Row[]> = {
  Person: [
    [1, 'alice', 'eng'],
    [2, 'bob', 'eng'],
    [3, 'carol', 'ops'],
  ],
  Salary: [
    [1, 140],
    [2, 120],
    [3, 95],
  ],
}

/** Run a program and net the diffs into a row set per relation. */
function run(source: string, facts: Record<string, Row[]> = FACTS): Map<string, string[]> {
  const net = new Map<string, Map<string, number>>()
  executeProgram(
    parseProgram(source, { grammarSource: 'q.dl' }),
    new Map(Object.entries(facts).map(([r, rows]) => [r, rows.map((x) => [...x])])),
    {},
    (rel, row, diff) => {
      let bucket = net.get(rel)
      if (!bucket) net.set(rel, (bucket = new Map()))
      const key = row.join(',')
      bucket.set(key, (bucket.get(key) ?? 0) + diff)
    },
  )
  const out = new Map<string, string[]>()
  for (const [rel, bucket] of net) {
    out.set(rel, [...bucket].filter(([, n]) => n > 0).map(([k]) => k).sort())
  }
  return out
}

describe('a query executes like any other rule', () => {
  it('derives its rows, aggregate and all', () => {
    const out = run(`${EDB}\n?- Payroll(d, sum(s)) :- Person(i, n, d), Salary(i, s).\n`)
    expect(out.get('Payroll')).toEqual(['eng,260', 'ops,95'])
  })

  it('unions two rules over one head', () => {
    const out = run(`${EDB}\n?- Who(n) :- Person(i, n, "eng").\n?- Who(n) :- Person(i, n, "ops").\n`)
    expect(out.get('Who')).toEqual(['alice', 'bob', 'carol'])
  })

  it('reads another query, so queries compose', () => {
    const out = run(
      `${EDB}\n?- Paid(n, s) :- Person(i, n, d), Salary(i, s).\n?- Rich(n) :- Paid(n, s), s > 100.\n`,
    )
    expect(out.get('Rich')).toEqual(['alice', 'bob'])
  })

  it('recurses', () => {
    const out = run(
      `\
.in
.decl Edge(a: number, b: number)

?- Reach(a, b) :- Edge(a, b).
?- Reach(a, c) :- Reach(a, b), Edge(b, c).
`,
      { Edge: [[1, 2], [2, 3], [3, 4]] },
    )
    expect(out.get('Reach')).toEqual(['1,2', '1,3', '1,4', '2,3', '2,4', '3,4'])
  })

  it('sits alongside declared relations without disturbing them', () => {
    const out = run(
      `${EDB}\n.out\n.decl Names(n: string)\n\nNames(n) :- Person(i, n, d).\n\n?- Heads(d, count(n)) :- Person(i, n, d).\n`,
    )
    expect(out.get('Names')).toEqual(['alice', 'bob', 'carol'])
    expect(out.get('Heads')).toEqual(['eng,2', 'ops,1'])
  })
})

describe('a bare goal reports what its body binds', () => {
  it('shows every variable, in order of first appearance', () => {
    const out = run(`${EDB}\n?- Person(i, n, d), Salary(i, s), s > 100.\n`)
    expect(out.get('Query1')).toEqual(['1,alice,eng,140', '2,bob,eng,120'])
  })

  it('projects through wildcards', () => {
    const out = run(`${EDB}\n?- Person(_, n, _).\n`)
    expect(out.get('Query1')).toEqual(['alice', 'bob', 'carol'])
  })

  it('gets its types inferred like any other query', () => {
    const program = parseProgram(`${EDB}\n?- Person(i, n, d).\n`, { grammarSource: 'q.dl' })
    expect(inferRelationTypes(program).types.get('Query1')).toEqual([
      'Integer',
      'String',
      'String',
    ])
  })

  it('runs several goals side by side', () => {
    const out = run(`${EDB}\n?- Person(_, n, _).\n?- Salary(_, a).\n`)
    expect(out.get('Query1')).toEqual(['alice', 'bob', 'carol'])
    expect(out.get('Query2')).toEqual(['120', '140', '95'])
  })

  it('takes negation, and derives nothing when nothing qualifies', () => {
    // Every person has a salary here, so the antijoin is empty.
    const out = run(`${EDB}\n?- Person(i, n, d), !Salary(i, _).\n`)
    expect(out.get('Query1') ?? []).toEqual([])
  })

  it('finds the rows the antijoin does leave', () => {
    const out = run(`${EDB}\n?- Person(i, n, d), !Salary(i, _).\n`, {
      ...FACTS,
      Salary: [[1, 140]],
    })
    expect(out.get('Query1')).toEqual(['2,bob,eng', '3,carol,ops'])
  })
})

describe('the types come from inference', () => {
  it('recovers a query head the declaration left open', () => {
    const program = parseProgram(
      `${EDB}\n?- Payroll(d, sum(s)) :- Person(i, n, d), Salary(i, s).\n`,
      { grammarSource: 'q.dl' },
    )
    // The declaration itself carries nothing — that is the whole point.
    expect(program.idbs[0]!.attributes).toEqual([])
    const { types, unresolved } = inferRelationTypes(program)
    expect(types.get('Payroll')).toEqual(['String', 'Integer'])
    expect(unresolved).toEqual([])
  })

  it('reports a query it cannot pin down, rather than guessing', () => {
    // Nothing binds `z`, so there is no body position to trace the head to.
    const program = parseProgram(`${EDB}\n?- Odd(z) :- Person(i, n, d).\n`, {
      grammarSource: 'q.dl',
    })
    const { types, unresolved } = inferRelationTypes(program)
    expect(types.has('Odd')).toBe(false)
    expect(unresolved.map((u) => u.rel)).toEqual(['Odd'])
  })
})

describe('writing back through a query', () => {
  // The case inference was originally written for: a relation declared with no
  // attributes still needs column types before the backward path can build it a
  // fact channel. A `?-` query is exactly that relation, written shorter.
  const SOURCE = `${EDB}\n?- Roster(n, d) :- Person(i, n, d).\n`

  it('compiles shadow rules for it', () => {
    const shadow = compileShadow(parseProgram(SOURCE), { views: ['Roster'] })
    expect(shadow.writableColumns.Roster).toEqual([0, 1])
  })

  it('lands an edit on the fact behind it', () => {
    const session = openBackwardSession(parseProgram(SOURCE), {
      views: ['Roster'],
      parse: (src) => parseProgram(src, { grammarSource: 's.dl' }),
    })
    for (const row of FACTS.Person!) session.update('Person', row, +1)
    session.advance()

    const resolution = session.resolve(
      { rel: 'Roster', row: ['alice', 'eng'], newRow: ['alicia', 'eng'] },
      { commit: false },
    )
    expect(resolution.status).toBe('ok')
    expect(resolution.status === 'ok' && resolution.changes).toEqual([
      { kind: 'upd', rel: 'Person', row: [1, 'alice', 'eng'], newRow: [1, 'alicia', 'eng'] },
    ])
  })
})
