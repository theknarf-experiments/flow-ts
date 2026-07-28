// Resolving a view-update request into EDB changes, and checking them.
//
// `compileShadow` answers "which source tuples could have produced this row".
// That answer is always *sound* — every candidate really did support the row —
// but it is not always *sufficient*, and the two ways it falls short are both
// invisible in the rule text:
//
//   • Negation is non-monotone. Retracting the fact supporting a row can
//     unblock a second derivation of the same row, so it comes back.
//   • Aliasing. One tuple can satisfy two body atoms, so rewriting it to
//     satisfy one destroys the other's witness.
//
// Whether either happens depends on the data, so no static analysis catches
// them. What closes the gap is running the forward program on the proposed
// facts and comparing: propose → apply → re-run → compare → commit or reject.
// The proposal only ever has to be a good guess; the engine is what makes
// acting on it safe. And the check is affordable because re-deriving is what
// this engine is for.
//
// Deletes additionally *iterate*: if the row survives its own support, ask
// again against the new state. That terminates because each round strictly
// shrinks a finite EDB and safety guarantees an empty one derives nothing.

import type { Program, PutPolicy } from '../ast/index.js'
import { executeProgram } from '../executing/dataflow.js'
import type { Row } from '../reading/row.js'
import { inferRelationTypes } from '../typing/index.js'
import { validateRequest } from './validate.js'
import {
  SEED_INS_PREFIX,
  SEED_PREFIX,
  SEED_UPD_PREFIX,
  type ShadowOptions,
  compileShadow,
} from './compile.js'

export type Facts = Record<string, Row[]>

/** A change to apply to the EDB. `upd` carries the replacement in `newRow`;
 *  the shape matches a plugin's `updateFact(content, oldFact, newFact)`. */
export interface Change {
  kind: 'del' | 'ins' | 'upd'
  rel: string
  row: Row
  newRow?: Row
}

export interface BackwardRequest {
  /** The view being edited. */
  rel: string
  /** The row as served to the client. */
  row: Row
  /** Present for a cell edit: what the row should become. */
  newRow?: Row
  /** Ask for the row to *exist* rather than to go away. Mutually exclusive
   *  with `newRow`. */
  insert?: boolean
}

export type Resolution =
  | { status: 'ok'; changes: Change[]; rounds: number }
  | { status: 'refused'; reason: string }
  | { status: 'ambiguous'; candidates: Change[]; reason: string }
  /** Sound candidates that provably don't achieve the request. */
  | { status: 'unsatisfied'; attempted: Change[]; reason: string }

export interface ResolveOptions extends ShadowOptions {
  /** How to read the generated shadow program back in.
   *
   *  flow-ts has no parser dependency on purpose — `@flow-ts/parsing` depends
   *  on *this* package for the AST, not the other way round, so that consumers
   *  can bring their own syntax. The caller therefore supplies the reader,
   *  normally `parseProgram` from `@flow-ts/parsing`. */
  parse: (source: string) => Program
  /** Report `ambiguous` instead of applying every candidate when a request
   *  reaches more than one source relation. Callers that own a UI usually want
   *  this; a batch rewrite usually doesn't. */
  requireUnambiguous?: boolean
  /** Cap on delete rounds. Reached only by pathological programs. */
  maxRounds?: number
  /** Shrink the result to an *irreducible* set: one where putting any single
   *  change back brings the target back.
   *
   *  The shadow fixpoint of a recursive rule computes support — every tuple
   *  participating in any derivation — and deleting all of it is correct but
   *  wildly over-aggressive: removing one arc from a path is usually enough.
   *  A globally minimum cut is a combinatorial problem; dropping changes one at
   *  a time and keeping each drop that still works costs one verification per
   *  candidate and yields a set with no redundant member. */
  minimize?: boolean
}

const keyOf = (row: Row): string => row.map((v) => `${typeof v}:${v}`).join('')

/** Resolve a request against the current facts, verified by re-running the
 *  forward program. */
export function resolveBackward(
  program: Program,
  facts: Facts,
  request: BackwardRequest,
  options: ResolveOptions,
): Resolution {
  const maxRounds = options.maxRounds ?? 12
  const isUpdate = request.newRow !== undefined
  const isInsert = request.insert === true

  // Only the relation being asked about needs a channel. Building them for
  // every view would compile rules — and force the indexes behind them — that
  // this request can never reach, and a one-shot resolve pays that in full.
  // The caller can still widen it, but there is no reason to by default.
  const shadow = compileShadow(program, {
    ...options,
    views: options.views ?? [request.rel],
  })
  // Shape first. A mistyped row would otherwise just fail to join, and get
  // reported as stale data rather than as the malformed request it is.
  const malformed = validateRequest(
    program,
    inferRelationTypes(program),
    shadow.seeds,
    request,
  )
  if (malformed) return { status: 'refused', reason: malformed }

  const live = liveRows(program, facts, request.rel).has(keyOf(request.row))
  if (isInsert && live) {
    return {
      status: 'refused',
      reason: `${request.rel}(${request.row.join(', ')}) is already derived`,
    }
  }
  if (!isInsert && !live) {
    return {
      status: 'refused',
      reason: `${request.rel}(${request.row.join(', ')}) is not derived from the current facts (stale?)`,
    }
  }

  let shadowProgram: Program
  try {
    shadowProgram = options.parse(shadow.source)
  } catch (err) {
    /* c8 ignore next 2 */
    return { status: 'refused', reason: `shadow program failed to compile: ${String(err)}` }
  }
  const edbNames = new Set(program.edbs.map((d) => d.name))
  // Same precedence as the compiler: a caller-supplied policy overrides the
  // one in the source text.
  const policy =
    options.put?.[request.rel] ?? program.idbs.find((d) => d.name === request.rel)?.put

  if (isInsert) {
    const changes = propose(shadowProgram, edbNames, facts, request)
    if (changes.length === 0) {
      return { status: 'refused', reason: noCandidateReason(shadow.refusals, request, policy) }
    }
    const ambiguity = checkAmbiguous(changes, options)
    if (ambiguity) return ambiguity

    const after = apply(facts, changes)
    if (!liveRows(program, after, request.rel).has(keyOf(request.row))) {
      return {
        status: 'unsatisfied',
        attempted: changes,
        reason:
          `the insert did not produce ${request.rel}(${request.row.join(', ')}) — ` +
          'the rule cannot be satisfied by adding facts alone',
      }
    }
    return { status: 'ok', changes, rounds: 1 }
  }

  if (isUpdate) {
    const changes = propose(shadowProgram, edbNames, facts, request)
    if (changes.length === 0) {
      return { status: 'refused', reason: noCandidateReason(shadow.refusals, request, policy) }
    }
    const ambiguity = checkAmbiguous(changes, options)
    if (ambiguity) return ambiguity

    const after = apply(facts, changes)
    if (!liveRows(program, after, request.rel).has(keyOf(request.newRow!))) {
      return {
        status: 'unsatisfied',
        attempted: changes,
        reason:
          `the rewrite did not produce ${request.rel}(${request.newRow!.join(', ')})` +
          collateral(program, facts, after, request.rel),
      }
    }
    return { status: 'ok', changes, rounds: 1 }
  }

  // Delete: iterate until the row stays gone.
  const all: Change[] = []
  let current = facts
  for (let rounds = 1; rounds <= maxRounds; rounds++) {
    const changes = propose(shadowProgram, edbNames, current, request)
    if (changes.length === 0) {
      return {
        status: 'refused',
        reason: rounds === 1 ? noCandidateReason(shadow.refusals, request, policy) : 'no further candidates',
      }
    }
    if (rounds === 1) {
      const ambiguity = checkAmbiguous(changes, options)
      if (ambiguity) return ambiguity
    }
    all.push(...changes)
    current = apply(current, changes)
    if (!liveRows(program, current, request.rel).has(keyOf(request.row))) {
      const kept = options.minimize
        ? shrink(all, (subset) =>
            !liveRows(program, apply(facts, subset), request.rel).has(keyOf(request.row)),
          )
        : all
      return { status: 'ok', changes: kept, rounds }
    }
  }
  return {
    status: 'unsatisfied',
    attempted: all,
    reason: `the row survived ${maxRounds} rounds of retraction`,
  }
}

// --- internals --------------------------------------------------------------

/** Every derived relation's live rows, in one pass. Rows are kept, not just
 *  keys, so a message can show values rather than an encoding. */
function allLiveRows(program: Program, facts: Facts): Map<string, Map<string, Row>> {
  const counts = new Map<string, Map<string, number>>()
  const rows = new Map<string, Map<string, Row>>()
  executeProgram(program, new Map(Object.entries(facts)), {}, (rel, row, diff) => {
    const m = counts.get(rel) ?? new Map<string, number>()
    const k = keyOf(row)
    m.set(k, (m.get(k) ?? 0) + diff)
    counts.set(rel, m)
    const r = rows.get(rel) ?? new Map<string, Row>()
    r.set(k, [...row])
    rows.set(rel, r)
  })
  const out = new Map<string, Map<string, Row>>()
  for (const [rel, m] of counts) {
    const live = new Map<string, Row>()
    for (const [k, n] of m) if (n > 0) live.set(k, rows.get(rel)!.get(k)!)
    out.set(rel, live)
  }
  return out
}

/** Name what the change knocked out on its way past.
 *
 *  "It didn't work" is true but unhelpful, and the useful part is usually one
 *  step removed: the tuple that was rewritten was also holding up something
 *  else, and that something else is what the row needed. Finding it costs two
 *  evaluations, paid only on the failure path. */
function collateral(
  program: Program,
  before: Facts,
  after: Facts,
  target: string,
): string {
  const was = allLiveRows(program, before)
  const now = allLiveRows(program, after)
  for (const [rel, rows] of was) {
    if (rel === target) continue
    const remaining = now.get(rel) ?? new Map<string, Row>()
    for (const [k, row] of rows) {
      if (remaining.has(k)) continue
      return (
        ` — it also removed ${rel}(${row.join(', ')}), which that row depends on. ` +
        'The tuple it rewrote was holding up more than one thing.'
      )
    }
  }
  return ' — a source tuple it changed is also relied on elsewhere in the rule'
}

/** Which channel a request enters on, and the row it carries. */
export function seedFor(request: BackwardRequest): [string, Row[]] {
  if (request.newRow !== undefined) {
    return [`${SEED_UPD_PREFIX}${request.rel}`, [[...request.row, ...request.newRow]]]
  }
  if (request.insert) return [`${SEED_INS_PREFIX}${request.rel}`, [request.row]]
  return [`${SEED_PREFIX}${request.rel}`, [request.row]]
}

/** Drop changes one at a time, keeping each drop that still satisfies `holds`.
 *
 *  The result is irreducible rather than minimum: no single member can be
 *  removed, though a smaller set might exist that this order never reaches.
 *  Being clear about which of the two it is matters — one is checkable in
 *  linear time and the other is not. */
export function shrink(
  changes: readonly Change[],
  holds: (subset: Change[]) => boolean,
): Change[] {
  // Try single changes first. Greedy dropping alone lands on whichever
  // irreducible set the iteration order happens to reach, and that can be far
  // from the smallest: for `H(x) :- A(x), C(y).` it drops the one load-bearing
  // A row — because emptying C also works — and keeps all of C instead. One
  // extra pass finds the common case, which is that a single fact was holding
  // the row up.
  if (changes.length > 1) {
    for (const c of changes) if (holds([c])) return [c]
  }

  let kept = [...changes]
  for (const c of changes) {
    const without = kept.filter((x) => x !== c)
    if (without.length !== kept.length && holds(without)) kept = without
  }
  return kept
}

function noCandidateReason(
  refusals: ReadonlyArray<{ subject: string; reason: string }>,
  request: BackwardRequest,
  policy: PutPolicy | null | undefined,
): string {
  // `.put none` and "the compiler could not work it out" both end with nothing
  // proposed, and they are not the same answer. One is a decision the schema
  // made; the other is a gap the schema could close. Saying "no candidate
  // change reaches a source relation" for a view that was *declared* read-only
  // invites the reader to go looking for the missing rule.
  if (policy?.kind === 'none') {
    return `${request.rel} is declared read-only with \`.put none\``
  }
  const relevant = refusals.filter((r) => r.subject.startsWith(`${request.rel}(`))
  return relevant.length > 0
    ? `no candidate: ${relevant[0]!.reason}`
    : `no candidate change reaches a source relation for ${request.rel}`
}

function checkAmbiguous(
  changes: readonly Change[],
  options: ResolveOptions,
): Resolution | null {
  if (!options.requireUnambiguous) return null
  const rels = new Set(changes.map((c) => c.rel))
  if (rels.size <= 1 && changes.length <= 1) return null
  return {
    status: 'ambiguous',
    candidates: [...changes],
    reason:
      rels.size > 1
        ? `the request reaches ${rels.size} source relations (${[...rels].join(', ')})`
        : `${changes.length} tuples of ${[...rels][0]} could be changed`,
  }
}

/** Run the shadow program once and read the candidate changes. */
function propose(
  shadowProgram: Program,
  edbNames: ReadonlySet<string>,
  facts: Facts,
  request: BackwardRequest,
): Change[] {
  const edbFacts = new Map<string, Row[]>(Object.entries(facts))
  const [rel, row] = seedFor(request)
  edbFacts.set(rel, row)

  const counts = new Map<string, Map<string, { row: Row; n: number }>>()
  executeProgram(shadowProgram, edbFacts, {}, (rel, row, diff) => {
    const m = counts.get(rel) ?? new Map()
    const k = keyOf(row)
    m.set(k, { row: [...row], n: (m.get(k)?.n ?? 0) + diff })
    counts.set(rel, m)
  })

  const out: Change[] = []
  for (const [rel, m] of counts) {
    const kind = rel.startsWith('Del_')
      ? ('del' as const)
      : rel.startsWith('Ins_')
        ? ('ins' as const)
        : rel.startsWith('Upd_')
          ? ('upd' as const)
          : null
    if (!kind) continue
    const base = rel.slice(rel.indexOf('_') + 1)
    if (!edbNames.has(base)) continue // an intermediate channel, not a write target
    for (const { row, n } of m.values()) {
      if (n <= 0) continue
      if (kind === 'upd') {
        const half = row.length / 2
        out.push({ kind, rel: base, row: row.slice(0, half), newRow: row.slice(half) })
      } else {
        out.push({ kind, rel: base, row })
      }
    }
  }
  return out
}

function apply(facts: Facts, changes: readonly Change[]): Facts {
  const out: Facts = { ...facts }
  for (const c of changes) {
    const rows = out[c.rel] ?? []
    if (c.kind === 'del') {
      out[c.rel] = rows.filter((r) => keyOf(r) !== keyOf(c.row))
    } else if (c.kind === 'ins') {
      out[c.rel] = rows.some((r) => keyOf(r) === keyOf(c.row)) ? rows : [...rows, c.row]
    } else {
      out[c.rel] = rows.map((r) => (keyOf(r) === keyOf(c.row) ? c.newRow! : r))
    }
  }
  return out
}

function liveRows(program: Program, facts: Facts, rel: string): Set<string> {
  const counts = new Map<string, number>()
  executeProgram(program, new Map(Object.entries(facts)), {}, (r, row, diff) => {
    if (r !== rel) return
    const k = keyOf(row)
    counts.set(k, (counts.get(k) ?? 0) + diff)
  })
  const out = new Set<string>()
  for (const [k, n] of counts) if (n > 0) out.add(k)
  return out
}
