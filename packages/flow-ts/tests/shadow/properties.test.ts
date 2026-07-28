// Property-based tests for backward propagation via shadow rules.
//
// The whole point of compiling the backward direction into Datalog is that
// the *forward* engine can then be used as an oracle: propose an EDB change,
// re-run the program, and check the view actually moved the way the request
// asked. That's the round-trip law (PutGet), and it's cheap here because
// `executeProgram` is right there.
//
// Properties, for a request "remove row r from view V":
//   1. Soundness      — every candidate is a tuple that currently exists.
//   2. Groundedness   — a row that isn't in the view yields no candidates.
//   3. Stability      — no request yields no candidates (GetPut).
//   4. Completeness   — deleting every candidate removes r from V.
//   5. Minimal case   — when exactly one candidate exists, deleting just that
//                       one removes r, and the view only ever shrinks.
//
// 4 and 5 hold for the positive fragment; negation is covered separately
// because deleting EDB tuples there can *add* derived rows.

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parseProgram } from '@flow-ts/parsing'
import { executeProgram } from '../../src/executing/index.js'
import type { Row } from '../../src/reading/index.js'
import { compileShadow } from '../../src/shadow/index.js'

// --- harness ----------------------------------------------------------------

type Facts = Record<string, Row[]>

const key = (row: Row): string => row.map((v) => `${typeof v}:${v}`).join('')

/** Candidate rows of one relation, keyed so they can be set-compared but kept
 *  as real `Row`s — a seed row has to carry the column's JS type, not a
 *  stringified shadow of it. */
type RowSet = Map<string, Row>

/** Live (net-positive) rows of one relation. */
function liveRows(source: string, facts: Facts, rel: string): RowSet {
  const counts = new Map<string, number>()
  const rows: RowSet = new Map()
  executeProgram(
    parseProgram(source, { grammarSource: 'fwd.dl' }),
    new Map(Object.entries(facts)),
    {},
    (r, row, diff) => {
      if (r !== rel) return
      const k = key(row)
      counts.set(k, (counts.get(k) ?? 0) + diff)
      rows.set(k, [...row])
    },
  )
  const out: RowSet = new Map()
  for (const [k, n] of counts) if (n > 0) out.set(k, rows.get(k)!)
  return out
}

/** Run the compiled shadow program and read the candidate EDB retractions
 *  (and insertions) at the write frontier. */
function backward(
  source: string,
  facts: Facts,
  seedRel: string,
  seedRow: Row,
): { del: Map<string, RowSet>; ins: Map<string, RowSet> } {
  const program = parseProgram(source, { grammarSource: 'fwd.dl' })
  const shadow = compileShadow(program)
  const shadowProgram = parseProgram(shadow.source, { grammarSource: 'shadow.dl' })
  const edbNames = new Set(program.edbs.map((d) => d.name))

  const edbFacts = new Map<string, Row[]>(Object.entries(facts))
  edbFacts.set(`Seed_${seedRel}`, [seedRow])

  const counts = new Map<string, Map<string, number>>()
  const rows = new Map<string, RowSet>()
  executeProgram(shadowProgram, edbFacts, {}, (rel, row, diff) => {
    const m = counts.get(rel) ?? new Map<string, number>()
    const k = key(row)
    m.set(k, (m.get(k) ?? 0) + diff)
    counts.set(rel, m)
    const rs = rows.get(rel) ?? new Map()
    rs.set(k, [...row])
    rows.set(rel, rs)
  })

  const collect = (prefix: string): Map<string, RowSet> => {
    const out = new Map<string, RowSet>()
    for (const [rel, m] of counts) {
      if (!rel.startsWith(prefix)) continue
      const base = rel.slice(prefix.length)
      if (!edbNames.has(base)) continue // intermediate IDB channel, not a write target
      const live: RowSet = new Map()
      for (const [k, n] of m) if (n > 0) live.set(k, rows.get(rel)!.get(k)!)
      if (live.size > 0) out.set(base, live)
    }
    return out
  }
  return { del: collect('Del_'), ins: collect('Ins_') }
}

const countCandidates = (c: Map<string, RowSet>): number => {
  let n = 0
  for (const rows of c.values()) n += rows.size
  return n
}

/** Apply candidate retractions to a fact set. */
function applyDeletes(facts: Facts, del: Map<string, RowSet>): Facts {
  const out: Facts = {}
  for (const [rel, rows] of Object.entries(facts)) {
    const drop = del.get(rel)
    out[rel] = drop ? rows.filter((r) => !drop.has(key(r))) : [...rows]
  }
  return out
}

const subset = (a: RowSet, b: RowSet): boolean => {
  for (const x of a.keys()) if (!b.has(x)) return false
  return true
}

/** Dedupe rows — Datalog is set-semantics, and duplicate input rows would
 *  make "delete this fact" ambiguous in a way that isn't about the compiler. */
function dedupe(facts: Facts): Facts {
  const out: Facts = {}
  for (const [rel, rows] of Object.entries(facts)) {
    const seen = new Map<string, Row>()
    for (const r of rows) seen.set(key(r), r)
    out[rel] = [...seen.values()]
  }
  return out
}

// --- program shapes ---------------------------------------------------------

interface Shape {
  name: string
  source: string
  view: string
  facts: fc.Arbitrary<Facts>
}

const smallInt = fc.integer({ min: 0, max: 4 })
const smallName = fc.constantFrom('a', 'b', 'c')

/** Existential recovery: `l` is projected away and must be replayed back. */
const PROJECTION: Shape = {
  name: 'projection',
  view: 'Open',
  source: `\
.in
.decl Task(path: string, status: string, text: string, line: number)
.input Task.csv

.printsize
.decl Open(p: string, t: string)

.rule
Open(p, t) :- Task(p, "open", t, l).
`,
  facts: fc
    .array(
      fc.tuple(smallName, fc.constantFrom('open', 'closed'), smallName, smallInt),
      { minLength: 0, maxLength: 6 },
    )
    .map((rows) => ({ Task: rows.map((r) => [...r] as Row) })),
}

/** Two writable sides: a delete could land on either relation. */
const JOIN: Shape = {
  name: 'join',
  view: 'Assigned',
  source: `\
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
  facts: fc
    .tuple(
      fc.array(fc.tuple(smallInt, smallInt), { minLength: 0, maxLength: 5 }),
      fc.array(fc.tuple(smallInt, smallName), { minLength: 0, maxLength: 5 }),
    )
    .map(([tasks, people]) => ({
      Task: tasks.map((r) => [...r] as Row),
      Person: people.map((r) => [...r] as Row),
    })),
}

/** A disjunction: every derivation has to be killed, not just one. */
const UNION: Shape = {
  name: 'union',
  view: 'H',
  source: `\
.in
.decl A(x: number)
.input A.csv
.decl B(x: number)
.input B.csv

.printsize
.decl H(x: number)

.rule
H(x) :- A(x).
H(x) :- B(x).
`,
  facts: fc
    .tuple(
      fc.array(smallInt, { minLength: 0, maxLength: 5 }),
      fc.array(smallInt, { minLength: 0, maxLength: 5 }),
    )
    .map(([a, b]) => ({ A: a.map((x) => [x] as Row), B: b.map((x) => [x] as Row) })),
}

/** Two hops: the request has to walk back through an intermediate IDB. */
const CHAIN: Shape = {
  name: 'chain',
  view: 'Top',
  source: `\
.in
.decl Base(x: number, y: number)
.input Base.csv

.printsize
.decl Mid(x: number, y: number)
.decl Top(x: number)

.rule
Mid(x, y) :- Base(x, y).
Top(x) :- Mid(x, y).
`,
  facts: fc
    .array(fc.tuple(smallInt, smallInt), { minLength: 0, maxLength: 6 })
    .map((rows) => ({ Base: rows.map((r) => [...r] as Row) })),
}

const SHAPES = [PROJECTION, JOIN, UNION, CHAIN]

/** Generate facts plus a target row drawn from the resulting view. Returns
 *  null when the view came out empty (nothing to ask for). */
function withTarget(shape: Shape) {
  return fc.tuple(shape.facts, fc.nat()).map(([raw, pick]) => {
    const facts = dedupe(raw)
    const view = [...liveRows(shape.source, facts, shape.view).values()]
    if (view.length === 0) return null
    return { facts, target: view[pick % view.length]! }
  })
}

// --- properties -------------------------------------------------------------

describe.each(SHAPES)('$name', (shape) => {
  it('soundness: every candidate is a tuple that currently exists', () => {
    fc.assert(
      fc.property(withTarget(shape), (input) => {
        if (!input) return true
        const { del } = backward(shape.source, input.facts, shape.view, input.target)
        for (const [rel, rows] of del) {
          const present = new Set((input.facts[rel] ?? []).map(key))
          for (const k of rows.keys()) if (!present.has(k)) return false
        }
        return true
      }),
      { numRuns: 60 },
    )
  })

  it('groundedness: a row not in the view yields no candidates', () => {
    fc.assert(
      fc.property(shape.facts, fc.nat(), (raw, pick) => {
        const facts = dedupe(raw)
        const view = liveRows(shape.source, facts, shape.view)
        if (view.size === 0) return true
        // Perturb one cell of a real row, preserving its column type, so the
        // request is well-typed but not something the program derives.
        const base = [...view.values()][pick % view.size]!
        const at = pick % base.length
        const cell = base[at]!
        const row = [...base]
        row[at] = typeof cell === 'number' ? cell + 1000 : `${cell}~absent`
        if (view.has(key(row))) return true // still derived; different property
        const { del } = backward(shape.source, facts, shape.view, row)
        return countCandidates(del) === 0
      }),
      { numRuns: 60 },
    )
  })

  it('stability: an empty request yields no candidates (GetPut)', () => {
    fc.assert(
      fc.property(shape.facts, (raw) => {
        const facts = dedupe(raw)
        const program = parseProgram(shape.source, { grammarSource: 'fwd.dl' })
        const shadow = compileShadow(program)
        const shadowProgram = parseProgram(shadow.source, { grammarSource: 'shadow.dl' })
        let candidates = 0
        executeProgram(shadowProgram, new Map(Object.entries(facts)), {}, (rel, _row, diff) => {
          if (rel.startsWith('Del_') || rel.startsWith('Ins_')) candidates += diff
        })
        return candidates === 0
      }),
      { numRuns: 40 },
    )
  })

  it('completeness: deleting every candidate removes the target', () => {
    fc.assert(
      fc.property(withTarget(shape), (input) => {
        if (!input) return true
        const { del } = backward(shape.source, input.facts, shape.view, input.target)
        if (countCandidates(del) === 0) return false // it was derived; something must support it
        const after = applyDeletes(input.facts, del)
        return !liveRows(shape.source, after, shape.view).has(key(input.target))
      }),
      { numRuns: 60 },
    )
  })
})

describe('the unambiguous case', () => {
  // Guard against a vacuous pass: assert afterwards that the single-candidate
  // branch was actually reached.
  it('a lone candidate is the correct minimal delete', () => {
    let exercised = 0
    for (const shape of SHAPES) {
      fc.assert(
        fc.property(withTarget(shape), (input) => {
          if (!input) return true
          const { del } = backward(shape.source, input.facts, shape.view, input.target)
          if (countCandidates(del) !== 1) return true
          exercised++
          const before = liveRows(shape.source, input.facts, shape.view)
          const after = liveRows(shape.source, applyDeletes(input.facts, del), shape.view)
          // The request is honoured…
          if (after.has(key(input.target))) return false
          // …and a positive program can only lose rows, never gain them.
          return subset(after, before)
        }),
        { numRuns: 120 },
      )
    }
    expect(exercised).toBeGreaterThan(0)
  })
})

describe('negation', () => {
  const SOURCE = `\
.in
.decl Item(x: number)
.input Item.csv
.decl Hidden(x: number)
.input Hidden.csv

.printsize
.decl Visible(x: number)

.rule
Visible(x) :- Item(x), !Hidden(x).
`

  it('offers both channels: drop the Item or add the Hidden', () => {
    fc.assert(
      fc.property(
        fc.array(smallInt, { minLength: 1, maxLength: 5 }),
        fc.array(smallInt, { minLength: 0, maxLength: 3 }),
        fc.nat(),
        (items, hidden, pick) => {
          const facts = dedupe({
            Item: items.map((x) => [x] as Row),
            Hidden: hidden.map((x) => [x] as Row),
          })
          const view = [...liveRows(SOURCE, facts, 'Visible').values()]
          if (view.length === 0) return true
          const target = view[pick % view.length]!

          const { del, ins } = backward(SOURCE, facts, 'Visible', target)
          // Retracting the Item works.
          const viaDel = liveRows(SOURCE, applyDeletes(facts, del), 'Visible')
          if (viaDel.has(key(target))) return false
          // So does inserting the Hidden — the polarity flip.
          const insHidden = ins.get('Hidden')
          if (!insHidden || insHidden.size === 0) return false
          const withHidden: Facts = {
            ...facts,
            Hidden: [...facts.Hidden!, ...insHidden.values()],
          }
          return !liveRows(SOURCE, withHidden, 'Visible').has(key(target))
        },
      ),
      { numRuns: 60 },
    )
  })
})

describe('recursion', () => {
  const SOURCE = `\
.in
.decl Arc(x: number, y: number)
.input Arc.csv

.printsize
.decl Path(x: number, y: number)

.rule
Path(x, y) :- Arc(x, y).
Path(x, z) :- Path(x, y), Arc(y, z).
`

  it('the shadow fixpoint yields the support set: deleting all of it works', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(smallInt, smallInt), { minLength: 1, maxLength: 6 }),
        fc.nat(),
        (edges, pick) => {
          const facts = dedupe({ Arc: edges.map((e) => [...e] as Row) })
          const view = [...liveRows(SOURCE, facts, 'Path').values()]
          if (view.length === 0) return true
          const target = view[pick % view.length]!

          const { del } = backward(SOURCE, facts, 'Path', target)
          if (countCandidates(del) === 0) return false
          // Support, not a minimal cut: removing all of it must sever the path.
          const after = liveRows(SOURCE, applyDeletes(facts, del), 'Path')
          return !after.has(key(target))
        },
      ),
      { numRuns: 50 },
    )
  })
})
