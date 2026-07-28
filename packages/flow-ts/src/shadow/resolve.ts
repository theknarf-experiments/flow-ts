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

import type { Program } from '../ast/index.js'
import { executeProgram } from '../executing/dataflow.js'
import type { Row } from '../reading/row.js'
import { inferRelationTypes } from '../typing/index.js'
import { validateRequest } from './validate.js'
import {
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

  const shadow = compileShadow(program, options)
  // Shape first. A mistyped row would otherwise just fail to join, and get
  // reported as stale data rather than as the malformed request it is.
  const malformed = validateRequest(
    program,
    inferRelationTypes(program),
    shadow.seeds,
    request,
  )
  if (malformed) return { status: 'refused', reason: malformed }

  if (!liveRows(program, facts, request.rel).has(keyOf(request.row))) {
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

  if (isUpdate) {
    const changes = propose(shadowProgram, edbNames, facts, request, true)
    if (changes.length === 0) {
      return { status: 'refused', reason: noCandidateReason(shadow.refusals, request) }
    }
    const ambiguity = checkAmbiguous(changes, options)
    if (ambiguity) return ambiguity

    const after = apply(facts, changes)
    if (!liveRows(program, after, request.rel).has(keyOf(request.newRow!))) {
      return {
        status: 'unsatisfied',
        attempted: changes,
        reason:
          `the rewrite did not produce ${request.rel}(${request.newRow!.join(', ')}) — ` +
          'a source tuple it changed is also relied on elsewhere in the rule',
      }
    }
    return { status: 'ok', changes, rounds: 1 }
  }

  // Delete: iterate until the row stays gone.
  const all: Change[] = []
  let current = facts
  for (let rounds = 1; rounds <= maxRounds; rounds++) {
    const changes = propose(shadowProgram, edbNames, current, request, false)
    if (changes.length === 0) {
      return {
        status: 'refused',
        reason: rounds === 1 ? noCandidateReason(shadow.refusals, request) : 'no further candidates',
      }
    }
    if (rounds === 1) {
      const ambiguity = checkAmbiguous(changes, options)
      if (ambiguity) return ambiguity
    }
    all.push(...changes)
    current = apply(current, changes)
    if (!liveRows(program, current, request.rel).has(keyOf(request.row))) {
      return { status: 'ok', changes: all, rounds }
    }
  }
  return {
    status: 'unsatisfied',
    attempted: all,
    reason: `the row survived ${maxRounds} rounds of retraction`,
  }
}

// --- internals --------------------------------------------------------------

function noCandidateReason(
  refusals: ReadonlyArray<{ subject: string; reason: string }>,
  request: BackwardRequest,
): string {
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
  isUpdate: boolean,
): Change[] {
  const edbFacts = new Map<string, Row[]>(Object.entries(facts))
  if (isUpdate) {
    edbFacts.set(`${SEED_UPD_PREFIX}${request.rel}`, [[...request.row, ...request.newRow!]])
  } else {
    edbFacts.set(`${SEED_PREFIX}${request.rel}`, [request.row])
  }

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
