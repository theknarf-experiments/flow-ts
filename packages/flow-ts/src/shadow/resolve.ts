// The vocabulary of a view-update request, and the parts of answering one that
// are the same wherever it is answered.
//
// The protocol itself — propose, apply, verify, minimise, commit or roll back —
// lives in `session.ts`, over a maintained graph. `one-shot.ts` wraps that for
// callers who want a pure function over facts they hold themselves. It used to
// be implemented twice, once here and once there, and the two drifted: every
// improvement to a message landed on one side only, so a session reported a
// truncated inverse as an aliasing conflict long after the one-shot had learnt
// to say what it actually was.
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
  type ShadowChannel,
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

// --- internals --------------------------------------------------------------

/** Live rows of every derived relation, keyed for comparison. */
export type LiveRows = ReadonlyMap<string, ReadonlyMap<string, Row>>

/** Name what the change knocked out on its way past.
 *
 *  "It didn't work" is true but unhelpful, and the useful part is usually one
 *  step removed: the tuple that was rewritten was also holding up something
 *  else, and that something else is what the row needed. Finding it costs two
 *  evaluations, paid only on the failure path. */
export function collateral(
  program: Program,
  before: LiveRows,
  after: LiveRows,
  target: string,
): string {
  const was = before
  const now = after

  // Landing somewhere else is its own failure, and a different one. An inverse
  // that doesn't round-trip — `h * 60` inverted by a division that truncates —
  // produces a perfectly good row that simply isn't the one asked for, and
  // saying "a tuple it changed is relied on elsewhere" sends the reader looking
  // for a conflict that isn't there. Check the target relation first, because
  // when this is what happened it is the whole explanation.
  const wasT = was.get(target) ?? new Map<string, Row>()
  const appeared = [...(now.get(target) ?? new Map<string, Row>())].filter(([k]) => !wasT.has(k))
  if (appeared.length === 1) {
    return (
      ` — it produced ${target}(${appeared[0]![1].join(', ')}) instead, so the inverse ` +
      'it applied does not round-trip'
    )
  }

  // Otherwise something the row rests on was knocked out. Only relations the
  // target actually reads can be that, so "which that row depends on" is a
  // claim worth checking rather than asserting: an unrelated view that happens
  // to read the same source relation changes too, and naming it would be a
  // coincidence dressed up as a cause.
  const upstream = dependencies(program, target)
  for (const [rel, rows] of was) {
    if (rel === target || !upstream.has(rel)) continue
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

/** Every relation `target` reads, transitively. */
function dependencies(program: Program, target: string): Set<string> {
  const bodies = new Map<string, string[]>()
  for (const rule of program.rules) {
    const names = rule.rhs.flatMap((p) => (p.kind === 'Compare' ? [] : [p.atom.name]))
    bodies.set(rule.head.name, [...(bodies.get(rule.head.name) ?? []), ...names])
  }
  const seen = new Set<string>()
  const queue = [target]
  while (queue.length > 0) {
    for (const next of bodies.get(queue.pop()!) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return seen
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

export function noCandidateReason(
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

export function checkAmbiguous(
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



