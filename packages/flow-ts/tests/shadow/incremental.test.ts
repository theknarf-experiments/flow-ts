// Is backward propagation actually incremental?
//
// This is the load-bearing claim of the whole shadow-rules design. Compiling the
// backward direction into Datalog is only better than an imperative reverse
// traversal if the shadow graph is *maintained* — if a request costs the delta
// rather than a re-run, and if the candidate set stays live as facts change.
// Everything up to now went through `executeProgram`, i.e. batch, so the claim
// was untested.
//
// The metric here is sink emissions, not wall-clock: deterministic, and it
// measures the thing we actually care about. A batch run re-derives every IDB
// row from scratch, so its cost grows with the database. An incremental request
// should emit only what changed.

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parseProgram } from '@flow-ts/parsing'
import { executeProgram } from '../../src/executing/index.js'
import type { Row } from '../../src/reading/index.js'
import { compileShadow, openBackwardSession, resolveBackward } from '../../src/shadow/index.js'
import { backward, dedupe, key, liveRows } from './_harness.js'
import { programGen } from './_gen.js'

type Facts = Record<string, Row[]>

const PARSE = { parse: (src: string) => parseProgram(src, { grammarSource: 'shadow.dl' }), views: 'all' as const }

const PROJECTION_SRC = `\
.in
.decl Task(path: string, status: string, text: string, line: number)
.input Task.csv

.printsize
.decl Open(p: string, t: string)

.rule
Open(p, t) :- Task(p, "open", t, l).
`
const PROJECTION = parseProgram(PROJECTION_SRC, { grammarSource: 'p.dl' })

const TASKS: Facts = {
  Task: [
    ['a.md', 'open', 'milk', 3],
    ['a.md', 'open', 'bread', 7],
    ['b.md', 'closed', 'eggs', 1],
  ],
}

/** Open a session and load facts, returning it ready for requests. */
function loaded(program = PROJECTION, facts = TASKS, options = {}) {
  const s = openBackwardSession(program, { ...PARSE, ...options })
  for (const [rel, rows] of Object.entries(facts)) {
    for (const row of rows) s.update(rel, row, 1)
  }
  s.advance()
  return s
}

const asKeys = (changes: ReadonlyArray<{ kind: string; rel: string; row: Row; newRow?: Row }>) =>
  changes.map((c) => `${c.kind} ${c.rel}(${c.row.join(',')})${c.newRow ? `→(${c.newRow.join(',')})` : ''}`).sort()

describe('the session maintains both directions', () => {
  it('answers view queries from maintained state', () => {
    const s = loaded()
    expect(s.rows('Open').map((r) => r.join(','))).toEqual(
      expect.arrayContaining(['a.md,milk', 'a.md,bread']),
    )
    s.close()
  })

  it('proposes the same candidates as a batch run', () => {
    const s = loaded()
    const incremental = s.propose({ rel: 'Open', row: ['a.md', 'milk'] })
    s.close()
    const batch = resolveBackward(PROJECTION, TASKS, { rel: 'Open', row: ['a.md', 'milk'] }, PARSE)
    expect(batch.status).toBe('ok')
    if (batch.status !== 'ok') return
    expect(asKeys(incremental)).toEqual(asKeys(batch.changes))
  })

  it('leaves no shadow rows behind, so the session is reusable', () => {
    const s = loaded()
    s.propose({ rel: 'Open', row: ['a.md', 'milk'] })
    // The seed is retracted after reading, so every channel is empty again.
    expect(s.rows('Del_Task')).toEqual([])
    expect(s.rows('Del_Open')).toEqual([])
    // …and a second request is unaffected by the first.
    expect(asKeys(s.propose({ rel: 'Open', row: ['a.md', 'bread'] }))).toEqual([
      'del Task(a.md,open,bread,7)',
    ])
    s.close()
  })

  it('successive requests match successive batch runs', () => {
    const s = loaded()
    for (const t of ['milk', 'bread', 'milk']) {
      const inc = s.propose({ rel: 'Open', row: ['a.md', t] })
      const b = resolveBackward(PROJECTION, TASKS, { rel: 'Open', row: ['a.md', t] }, PARSE)
      expect(b.status).toBe('ok')
      if (b.status === 'ok') expect(asKeys(inc)).toEqual(asKeys(b.changes))
    }
    s.close()
  })

  it('reflects EDB changes between requests — the candidate set stays live', () => {
    const s = loaded()
    expect(asKeys(s.propose({ rel: 'Open', row: ['a.md', 'milk'] }))).toEqual([
      'del Task(a.md,open,milk,3)',
    ])

    // A second Task deriving the same view row makes the request ambiguous,
    // without rebuilding anything.
    s.update('Task', ['a.md', 'open', 'milk', 99], 1)
    s.advance()
    expect(asKeys(s.propose({ rel: 'Open', row: ['a.md', 'milk'] }))).toEqual([
      'del Task(a.md,open,milk,3)',
      'del Task(a.md,open,milk,99)',
    ])

    // Retracting it restores the earlier answer exactly.
    s.update('Task', ['a.md', 'open', 'milk', 99], -1)
    s.advance()
    expect(asKeys(s.propose({ rel: 'Open', row: ['a.md', 'milk'] }))).toEqual([
      'del Task(a.md,open,milk,3)',
    ])
    s.close()
  })
})

describe('resolve, incrementally', () => {
  it('commits a delete and reflects it in the maintained view', () => {
    const s = loaded()
    const r = s.resolve({ rel: 'Open', row: ['a.md', 'milk'] })
    expect(r.status).toBe('ok')
    expect(s.rows('Open').map((x) => x.join(','))).not.toContain('a.md,milk')
    s.close()
  })

  it('rolls back exactly when a proposal does not achieve the request', () => {
    const SRC = `\
.in
.decl E0(a: number, b: number)
.input E0.csv

.printsize
.decl I0(d: number, a: number)

.rule
I0(d, a) :- E0(d, 1), E0(d, a).
`
    const s = loaded(parseProgram(SRC, { grammarSource: 'x.dl' }), { E0: [[1, 1]] })
    const before = s.rows('I0').map((r) => r.join(',')).sort()
    const edbBefore = s.rows('E0').map((r) => r.join(',')).sort()

    const r = s.resolve({ rel: 'I0', row: [1, 1], newRow: [1, 9] })
    expect(r.status).toBe('unsatisfied')

    // Speculation has to be undone completely, or the session is poisoned.
    expect(s.rows('I0').map((x) => x.join(',')).sort()).toEqual(before)
    expect(s.rows('E0').map((x) => x.join(',')).sort()).toEqual(edbBefore)
    s.close()
  })

  it('iterates for the negation case, like the batch resolver', () => {
    const SRC = `\
.in
.decl E0(a: number, b: number, c: number)
.input E0.csv

.printsize
.decl I0(a: number)

.rule
I0(a) :- E0(a, d, b), !E0(a, a, d).
`
    const s = loaded(parseProgram(SRC, { grammarSource: 'n.dl' }), {
      E0: [[0, 0, 1], [0, 1, 1]],
    })
    const r = s.resolve({ rel: 'I0', row: [0] })
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.rounds).toBeGreaterThan(1)
    expect(s.rows('I0')).toEqual([])
    s.close()
  })
})

describe('a request costs the delta, not the database', () => {
  /** Sink emissions for one batch request. */
  function batchCost(facts: Facts, target: Row): number {
    const shadow = compileShadow(PROJECTION)
    const sp = parseProgram(shadow.source, { grammarSource: 's.dl' })
    const edb = new Map<string, Row[]>(Object.entries(facts))
    edb.set('Seed_Open', [target])
    let n = 0
    executeProgram(sp, edb, {}, () => {
      n++
    })
    return n
  }

  /** Sink emissions for one request against an already-loaded session. */
  function incrementalCost(facts: Facts, target: Row): number {
    const s = openBackwardSession(PROJECTION, PARSE)
    for (const [rel, rows] of Object.entries(facts)) for (const r of rows) s.update(rel, r, 1)
    s.advance()
    const before = s.emissions()
    s.propose({ rel: 'Open', row: target })
    const cost = s.emissions() - before
    s.close()
    return cost
  }

  it('batch grows with the database; incremental does not', () => {
    const target: Row = ['a.md', 'milk']
    const measure = (n: number) => {
      const facts: Facts = {
        Task: [
          ['a.md', 'open', 'milk', 0],
          ...Array.from({ length: n }, (_, i) => ['z.md', 'open', `t${i}`, i] as Row),
        ],
      }
      return { batch: batchCost(facts, target), inc: incrementalCost(facts, target) }
    }

    const small = measure(5)
    const large = measure(80)
    console.log(
      `\n  db=5   batch=${small.batch} incremental=${small.inc}` +
        `\n  db=80  batch=${large.batch} incremental=${large.inc}\n`,
    )

    // Batch re-derives everything, so its cost tracks the database.
    expect(large.batch).toBeGreaterThan(small.batch * 3)
    // The incremental request touches only what the seed reaches.
    expect(large.inc).toEqual(small.inc)
    // And it is far cheaper in absolute terms once the database is non-trivial.
    expect(large.inc * 5).toBeLessThan(large.batch)
  })
})

describe('sideways information passing', () => {
  // A shadow rule is the original body plus one highly selective seed atom, so
  // SIP is precisely the optimisation it wants: push the seed's bindings into
  // the body and the replay becomes an index probe rather than a scan. Sink
  // emissions can't see that — it happens inside the graph — so correctness is
  // asserted and cost is reported.
  const JOIN = parseProgram(
    `\
.in
.decl Task(id: number, pid: number)
.input Task.csv
.decl Person(pid: number, name: string)
.input Person.csv

.printsize
.decl Assigned(id: number, name: string)

.rule
Assigned(i, n) :- Task(i, p), Person(p, n).
`,
    { grammarSource: 'j.dl' },
  )

  const facts = (n: number): Facts => ({
    Task: Array.from({ length: n }, (_, i) => [i, i % 20] as Row),
    Person: Array.from({ length: 20 }, (_, i) => [i, `p${i}`] as Row),
  })

  it('SIP does not change the answers', () => {
    const f = facts(200)
    const answers = [null, 1, 2, 3].map((optLevel) => {
      const s = openBackwardSession(JOIN, { ...PARSE, optLevel })
      for (const [rel, rowset] of Object.entries(f)) for (const r of rowset) s.update(rel, r, 1)
      s.advance()
      const got = asKeys(s.propose({ rel: 'Assigned', row: [7, 'p7'] }))
      s.close()
      return got.join('|')
    })
    expect(new Set(answers).size).toBe(1)
    expect(answers[0]).toContain('del Task(7,7)')
  })

  // Reported rather than asserted — wall-clock in a test suite is not a
  // contract. But the shape has been stable across runs and machine states, and
  // it says two things worth writing down:
  //
  //   • Request cost is flat in database size, which is the incrementality
  //     claim on wall-clock as well as on emission counts.
  //   • SIP consistently *costs* about 5x and never pays off, which is the
  //     opposite of what I expected. Incremental maintenance has already built
  //     the join index, so the body replay is already a probe; SIP's extra
  //     semijoin transformations are overhead per advance, and the scan it
  //     avoids is one a maintained graph never performs. Planning (-O 2) is
  //     best or tied throughout.
  it('reports request cost across sizes and optimisation levels', () => {
    const rows: string[] = []
    for (const n of [200, 2000]) {
      const f = facts(n)
      const cells: string[] = []
      for (const optLevel of [null, 1, 2, 3]) {
        const s = openBackwardSession(JOIN, { ...PARSE, optLevel })
        for (const [rel, rs] of Object.entries(f)) for (const r of rs) s.update(rel, r, 1)
        s.advance()
        const probe = (i: number) => s.propose({ rel: 'Assigned', row: [i % n, `p${(i % n) % 20}`] })
        for (let i = 0; i < 20; i++) probe(i) // warm up
        const start = performance.now()
        for (let i = 0; i < 60; i++) probe(i)
        cells.push(`-O${optLevel ?? 0}=${((performance.now() - start) / 60).toFixed(3)}ms`)
        s.close()
      }
      rows.push(`  Task=${n}: ${cells.join('  ')}`)
    }
    console.log(`\nrequest cost (60 requests, warmed)\n${rows.join('\n')}\n`)
    expect(rows).toHaveLength(2)
  })
})

describe('properties', () => {
  it('incremental propose ≡ batch propose, over generated programs', () => {
    let exercised = 0
    fc.assert(
      fc.property(programGen, fc.nat(), (p, pick) => {
        const facts = dedupe(p.facts)
        const program = parseProgram(p.source, { grammarSource: 'gen.dl' })
        for (const idb of p.idbs) {
          const view = [...liveRows(p.source, facts, idb.name).values()]
          if (view.length === 0) continue
          const target = view[pick % view.length]!

          const s = openBackwardSession(program, PARSE)
          for (const [rel, rows] of Object.entries(facts)) {
            for (const r of rows) s.update(rel, r, 1)
          }
          s.advance()
          const inc = s.propose({ rel: idb.name, row: target })
          s.close()

          // Compare against a *single* batch run of the same shadow program.
          // `resolveBackward` iterates and accumulates across rounds, so it is
          // the wrong yardstick for one proposal.
          const b = backward(p.source, facts, idb.name, target)
          const batchChanges: Array<{ kind: string; rel: string; row: Row; newRow?: Row }> = []
          for (const [kind, m] of [['del', b.del], ['ins', b.ins], ['upd', b.upd]] as const) {
            for (const [rel, rowset] of m) {
              for (const row of rowset.values()) {
                if (kind === 'upd') {
                  const half = row.length / 2
                  batchChanges.push({ kind, rel, row: row.slice(0, half), newRow: row.slice(half) })
                } else {
                  batchChanges.push({ kind, rel, row })
                }
              }
            }
          }
          exercised++
          if (asKeys(inc).join('|') !== asKeys(batchChanges).join('|')) {
            throw new Error(
              `incremental ≠ batch\n  inc:   ${asKeys(inc).join(' ')}\n  batch: ${asKeys(batchChanges).join(' ')}\n  rules:\n  ${p.rules.join('\n  ')}`,
            )
          }
          return true
        }
        return true
      }),
      { numRuns: 200 },
    )
    expect(exercised).toBeGreaterThan(50)
  })

  it('a proposal leaves the session exactly as it found it', () => {
    fc.assert(
      fc.property(programGen, fc.nat(), (p, pick) => {
        const facts = dedupe(p.facts)
        const program = parseProgram(p.source, { grammarSource: 'gen.dl' })
        const s = openBackwardSession(program, PARSE)
        for (const [rel, rows] of Object.entries(facts)) {
          for (const r of rows) s.update(rel, r, 1)
        }
        s.advance()

        const snapshot = () =>
          p.idbs
            .map((d) => `${d.name}:${s.rows(d.name).map((r) => key(r)).sort().join(';')}`)
            .join('|')
        const before = snapshot()

        for (const idb of p.idbs) {
          const view = s.rows(idb.name)
          if (view.length === 0) continue
          s.propose({ rel: idb.name, row: view[pick % view.length]! })
        }
        const after = snapshot()
        s.close()
        return before === after
      }),
      { numRuns: 200 },
    )
  })
})
