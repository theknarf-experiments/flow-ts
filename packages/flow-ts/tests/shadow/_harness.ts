// Shared harness for the shadow-rule tests.
//
// The point of keeping the backward direction in Datalog is that the forward
// engine can check it: seed a request, read the candidates, apply them, re-run
// the program, and see whether the view moved the way the request asked. These
// helpers are that loop.

import { parseProgram } from '../../src/parsing/index.js'
import { executeProgram } from '../../src/executing/index.js'
import type { Row } from '../../src/reading/index.js'
import { type ShadowOptions, compileShadow } from '../../src/shadow/index.js'

export type Facts = Record<string, Row[]>

/** Row identity that survives a round trip. The type tag matters: a seed row
 *  has to carry the column's JS type, and `1` vs `"1"` silently fails to join
 *  rather than erroring. */
export const key = (row: Row): string => row.map((v) => `${typeof v}:${v}`).join('')

/** Rows kept as real `Row`s but keyed for set comparison. */
export type RowSet = Map<string, Row>

/** Live (net-positive) rows of one relation. */
export function liveRows(source: string, facts: Facts, rel: string): RowSet {
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

export interface Candidates {
  del: Map<string, RowSet>
  ins: Map<string, RowSet>
  /** Rows of arity 2n: the old tuple followed by its replacement. */
  upd: Map<string, RowSet>
}

/** Compile the shadow program, seed a request, and read the candidate EDB
 *  changes at the write frontier.
 *
 *  Passing `newRow` seeds the *update* channel instead of the delete one. */
export function backward(
  source: string,
  facts: Facts,
  seedRel: string,
  seedRow: Row,
  newRow?: Row,
  options: ShadowOptions = {},
): Candidates {
  const program = parseProgram(source, { grammarSource: 'fwd.dl' })
  const shadow = compileShadow(program, options)
  const shadowProgram = parseProgram(shadow.source, { grammarSource: 'shadow.dl' })
  const edbNames = new Set(program.edbs.map((d) => d.name))

  const edbFacts = new Map<string, Row[]>(Object.entries(facts))
  if (newRow) edbFacts.set(`SeedUpd_${seedRel}`, [[...seedRow, ...newRow]])
  else edbFacts.set(`Seed_${seedRel}`, [seedRow])

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
      if (!edbNames.has(base)) continue // intermediate channel, not a write target
      const live: RowSet = new Map()
      for (const [k, n] of m) if (n > 0) live.set(k, rows.get(rel)!.get(k)!)
      if (live.size > 0) out.set(base, live)
    }
    return out
  }
  return { del: collect('Del_'), ins: collect('Ins_'), upd: collect('Upd_') }
}

/** Apply candidate rewrites: each row is `old ++ new`. */
export function applyUpdates(facts: Facts, upd: Map<string, RowSet>): Facts {
  const out: Facts = { ...facts }
  for (const [rel, rows] of upd) {
    const n = (out[rel]?.[0]?.length ?? 0) || [...rows.values()][0]!.length / 2
    const replace = new Map<string, Row>()
    for (const row of rows.values()) replace.set(key(row.slice(0, n)), row.slice(n))
    out[rel] = (out[rel] ?? []).map((r) => replace.get(key(r)) ?? r)
  }
  return out
}

export const countCandidates = (c: Map<string, RowSet>): number => {
  let n = 0
  for (const rows of c.values()) n += rows.size
  return n
}

/** Apply candidate retractions to a fact set. */
export function applyDeletes(facts: Facts, del: Map<string, RowSet>): Facts {
  const out: Facts = {}
  for (const [rel, rows] of Object.entries(facts)) {
    const drop = del.get(rel)
    out[rel] = drop ? rows.filter((r) => !drop.has(key(r))) : [...rows]
  }
  return out
}

/** Apply candidate insertions to a fact set. */
export function applyInserts(facts: Facts, ins: Map<string, RowSet>): Facts {
  const out: Facts = { ...facts }
  for (const [rel, rows] of ins) {
    const seen = new Map((out[rel] ?? []).map((r) => [key(r), r]))
    for (const [k, r] of rows) seen.set(k, r)
    out[rel] = [...seen.values()]
  }
  return out
}

export interface FixpointResult {
  facts: Facts
  /** Backward passes applied. */
  rounds: number
  /** Whether the target is gone from the view. */
  removed: boolean
  /** Why the loop stopped, when it didn't succeed. */
  stalled?: 'no-candidates' | 'no-progress' | 'round-limit'
}

/** Delete a row from a view, iterating until it stays gone.
 *
 *  One backward pass is enough for a positive program, but negation is
 *  non-monotone: retracting a fact can *un-block* a derivation that a negated
 *  atom was suppressing, so the target comes back. Re-requesting until the
 *  view is stable is the general form. It terminates because every round
 *  strictly shrinks a finite EDB, and safety guarantees an empty EDB derives
 *  nothing. */
export function deleteToFixpoint(
  source: string,
  facts: Facts,
  view: string,
  target: Row,
  maxRounds = 12,
): FixpointResult {
  let cur = facts
  const size = (f: Facts): number => Object.values(f).reduce((n, rows) => n + rows.length, 0)
  for (let rounds = 0; rounds <= maxRounds; rounds++) {
    if (!liveRows(source, cur, view).has(key(target))) return { facts: cur, rounds, removed: true }
    if (rounds === maxRounds) {
      return { facts: cur, rounds, removed: false, stalled: 'round-limit' }
    }
    const { del } = backward(source, cur, view, target)
    if (countCandidates(del) === 0) {
      return { facts: cur, rounds, removed: false, stalled: 'no-candidates' }
    }
    const next = applyDeletes(cur, del)
    if (size(next) === size(cur)) {
      return { facts: cur, rounds, removed: false, stalled: 'no-progress' }
    }
    cur = next
  }
  /* c8 ignore next */
  return { facts: cur, rounds: maxRounds, removed: false, stalled: 'round-limit' }
}

export const subset = (a: RowSet, b: RowSet): boolean => {
  for (const x of a.keys()) if (!b.has(x)) return false
  return true
}

/** Dedupe rows — Datalog is set-semantics, and duplicate input rows would make
 *  "delete this fact" ambiguous in a way that isn't about the compiler. */
export function dedupe(facts: Facts): Facts {
  const out: Facts = {}
  for (const [rel, rows] of Object.entries(facts)) {
    const seen = new Map<string, Row>()
    for (const r of rows) seen.set(key(r), r)
    out[rel] = [...seen.values()]
  }
  return out
}
