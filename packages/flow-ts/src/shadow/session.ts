// A long-lived session that maintains the forward *and* backward directions
// together.
//
// `resolveBackward` compiles, runs, and throws the graph away per request. That
// is fine for a one-shot CLI and wrong for anything interactive: the whole
// argument for compiling the backward direction into Datalog — rather than
// walking the graph imperatively — is that the shadow relations are ordinary
// IDBs and therefore *maintained*. A request should cost the delta, not a
// re-run, and the candidate set should stay live as facts change.
//
// One session holds one graph over `program + shadow(program)`. So the same
// state answers three questions that used to need three passes: what does the
// view currently say, what could have produced this row, and did applying the
// answer work.
//
// A request is seeded, read, and un-seeded. Un-seeding matters: the session has
// to come back to exactly where it was, or the next request sees the last one's
// residue. Z-set arithmetic gives that for free — retracting the seed retracts
// everything derived from it — and `a proposal leaves the session exactly as it
// found it` holds that to account over generated programs.
//
// That used to hold only for non-recursive programs, because retraction through
// a recursive stratum did not fully propagate and a proposal left residue for
// the next one. Fixed in db-ivm's `recursiveDistinct` and in the delete-before-
// insert staging in `openSession`, so recursion is no longer the dividing line.
//
// The last shape to go was a recursive atom used for nothing but existence,
// whose derivations the planner's unit projection collapsed into one before
// anything downstream could count them. Keeping that projection's multiplicity
// inside a loop — where it *is* the derivation count — closed it, and there is
// no recursive shape left that this refuses.
//
// Speculation works the same way. Apply the proposed EDB changes, advance, ask
// whether the view moved; if it didn't, apply the inverse and the session is
// unpoisoned. That is the propose → apply → verify → commit-or-rollback protocol
// with the rollback made cheap by the same mechanism as everything else.

import type { Program } from '../ast/index.js'
import { type ProgramSession, openSession } from '../executing/dataflow.js'
import type { Row } from '../reading/row.js'
import { inferRelationTypes } from '../typing/index.js'
import { SEED_INS_PREFIX, SEED_PREFIX, SEED_UPD_PREFIX, compileShadow } from './compile.js'
import { validateRequest } from './validate.js'
import type { ShadowChannel } from './compile.js'
import {
  type BackwardRequest,
  type Change,
  type LiveRows,
  type Resolution,
  type ResolveOptions,
  checkAmbiguous,
  collateral,
  noCandidateReason,
  seedFor,
  shrink,
} from './resolve.js'

const keyOf = (row: Row): string => row.map((v) => `${typeof v}:${v}`).join('')

export interface BackwardSessionOptions extends ResolveOptions {
  /** Passed through to `openSession`. `optLevel: 1` enables SIP, which turns a
   *  shadow rule's body replay into an index probe — the seed is a single
   *  highly selective row, so it is exactly the case SIP is for. */
  optLevel?: number | null
  noSharing?: boolean
}

export interface BackwardSession {
  /** Queue an EDB delta, mirroring a change to the real store. */
  update(relation: string, row: Row, diff?: number): void
  /** Drive the graph over the queued deltas. */
  advance(): void
  /** Live rows of any relation the graph maintains — a view, an EDB, or a
   *  shadow channel. No re-derivation. */
  rows(relation: string): Row[]
  /** Candidate changes for a request, with the session left untouched. */
  propose(request: BackwardRequest): Change[]
  /** The full protocol. On `ok` the changes are applied to the session, so it
   *  keeps mirroring the store the caller is about to write. On anything else
   *  the session is exactly as it was. */
  resolve(request: BackwardRequest): Resolution
  /** Sink emissions so far — the cost measure, since it counts work done
   *  rather than time taken. */
  emissions(): number
  close(): void
}

export function openBackwardSession(
  program: Program,
  options: BackwardSessionOptions,
): BackwardSession {
  // A session carries its graph for as long as it is open, so the scope of the
  // shadow rules is a standing cost rather than a per-request one — about 1.8x
  // to stand the graph up and about 3x per incremental step with every view
  // enabled, the latter on a base of a few microseconds and flat in data size.
  // That is a decision the caller has to make, so there is no default: say
  // which views are writable, or say 'all' and mean it.
  if (options.views === undefined) {
    throw new Error(
      'openBackwardSession: pass `views` to say which relations are writable. ' +
        'Every view carries shadow rules that force joins on their sources, which ' +
        'costs about 1.8x to load and 3x per step whether or not anyone writes — see ' +
        "`pnpm -F flow-ts run bench`. Pass `views: 'all'` to opt out of narrowing.",
    )
  }

  const shadow = compileShadow(program, options)
  const shadowProgram = options.parse(shadow.source)
  const inferred = inferRelationTypes(program)
  const edbNames = new Set(program.edbs.map((d) => d.name))
  const idbNames = new Set(program.idbs.map((d) => d.name))

  // Net multiplicity per (relation, row). This *is* the maintained state as far
  // as callers are concerned; the graph's own state lives in its operators.
  const state = new Map<string, Map<string, { row: Row; n: number }>>()
  let emissions = 0

  const session: ProgramSession = openSession(shadowProgram, options, (rel, row, diff) => {
    emissions++
    let m = state.get(rel)
    if (!m) state.set(rel, (m = new Map()))
    const k = keyOf(row)
    const cur = m.get(k)
    const n = (cur?.n ?? 0) + diff
    if (n === 0) m.delete(k)
    else m.set(k, { row: cur?.row ?? [...row], n })
  })

  // EDBs never come back through the sink, so mirror them here to answer
  // `rows()` for a source relation.
  const edbState = new Map<string, Map<string, { row: Row; n: number }>>()

  const rows = (relation: string): Row[] => {
    const m = state.get(relation) ?? edbState.get(relation)
    return m ? [...m.values()].filter((e) => e.n > 0).map((e) => e.row) : []
  }

  const update = (relation: string, row: Row, diff = 1): void => {
    session.update(relation, row, diff)
    if (!edbNames.has(relation)) return
    let m = edbState.get(relation)
    if (!m) edbState.set(relation, (m = new Map()))
    const k = keyOf(row)
    const cur = m.get(k)
    const n = (cur?.n ?? 0) + diff
    if (n === 0) m.delete(k)
    else m.set(k, { row: cur?.row ?? [...row], n })
  }

  /** Read the candidate changes currently sitting in the shadow channels. */
  const readChannels = (): Change[] => {
    const out: Change[] = []
    for (const [rel, m] of state) {
      const kind =
        rel.startsWith('Del_') ? ('del' as const)
        : rel.startsWith('Ins_') ? ('ins' as const)
        : rel.startsWith('Upd_') ? ('upd' as const)
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

  const propose = (request: BackwardRequest): Change[] => {
    // `propose` is the raw primitive, so a malformed request is a caller bug
    // and throws. `resolve` turns the same message into a `refused` status,
    // because there it is one outcome among several.
    const malformed = validateRequest(program, inferred, shadow.seeds, request)
    if (malformed) throw new Error(malformed)
    const [rel, [row]] = seedFor(request)
    update(rel, row!, 1)
    session.advance()
    const changes = readChannels()
    // Un-seed, so the next request starts from a clean channel set.
    update(rel, row!, -1)
    session.advance()
    return changes
  }

  const present = (rel: string, row: Row): boolean =>
    (edbState.get(rel)?.get(keyOf(row))?.n ?? 0) > 0

  /** Add or remove a row, idempotently.
   *
   *  A raw `update(rel, row, +1)` on a row that is already there takes its
   *  multiplicity to 2, and `rows()` still reports it once — so the mirror and
   *  the graph quietly disagree, and a later rollback leaves the row behind.
   *  Facts are a set here, so this makes the operation match. */
  const setRow = (rel: string, row: Row, wanted: boolean): void => {
    if (present(rel, row) === wanted) return
    update(rel, row, wanted ? 1 : -1)
  }

  /** Apply changes to the session; `sign = -1` inverts them for a rollback. */
  const applyChanges = (changes: readonly Change[], sign = 1): void => {
    for (const c of changes) {
      if (c.kind === 'del') setRow(c.rel, c.row, sign < 0)
      else if (c.kind === 'ins') setRow(c.rel, c.row, sign > 0)
      else {
        setRow(c.rel, c.row, sign < 0)
        setRow(c.rel, c.newRow!, sign > 0)
      }
    }
    session.advance()
  }

  const isLive = (rel: string, row: Row): boolean => {
    const m = state.get(rel)
    const e = m?.get(keyOf(row))
    return (e?.n ?? 0) > 0
  }

  /** Every derived relation's live rows. The graph already holds these, so a
   *  snapshot is a copy rather than an evaluation — which is what makes it
   *  affordable to take one on the failure path and explain what a rewrite
   *  knocked out on its way past. */
  const liveSnapshot = (): LiveRows => {
    const out = new Map<string, Map<string, Row>>()
    for (const [rel, m] of state) {
      if (!idbNames.has(rel)) continue
      const live = new Map<string, Row>()
      for (const [k, e] of m) if (e.n > 0) live.set(k, e.row)
      out.set(rel, live)
    }
    return out
  }

  // Same precedence as the compiler: a caller-supplied policy overrides the one
  // in the source text.
  const policyFor = (rel: string) =>
    options.put?.[rel] ?? program.idbs.find((d) => d.name === rel)?.put

  const resolve = (request: BackwardRequest): Resolution => {
    const malformed = validateRequest(program, inferred, shadow.seeds, request)
    if (malformed) return { status: 'refused', reason: malformed }

    const isUpdate = request.newRow !== undefined
    const isInsert = request.insert === true

    // A channel that was never compiled produces no candidates, and "no
    // candidate change reaches a source relation" is the wrong account of why:
    // nothing was looked at. The same distinction as `.put none` — a decision,
    // not a gap — except this one was made by the caller.
    const channel: ShadowChannel = isInsert ? 'ins' : isUpdate ? 'upd' : 'del'
    if (options.channels && !options.channels.includes(channel)) {
      return {
        status: 'refused',
        reason:
          `the "${channel}" channel was not compiled — this session opted into ` +
          `${options.channels.map((c) => `"${c}"`).join(', ')}`,
      }
    }

    const live = isLive(request.rel, request.row)
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

    const maxRounds = options.maxRounds ?? 12
    const applied: Change[] = []

    for (let rounds = 1; rounds <= maxRounds; rounds++) {
      const changes = propose(request)
      if (changes.length === 0) {
        if (applied.length > 0) applyChanges(applied, -1)
        return {
          status: 'refused',
          reason:
            rounds === 1
              ? noCandidateReason(shadow.refusals, request, policyFor(request.rel))
              : 'no further candidates',
        }
      }
      if (rounds === 1) {
        const ambiguity = checkAmbiguous(changes, options)
        if (ambiguity) return ambiguity
      }

      const before = isUpdate ? liveSnapshot() : null

      applyChanges(changes)
      applied.push(...changes)

      const achieved = isUpdate
        ? isLive(request.rel, request.newRow!)
        : isInsert
          ? isLive(request.rel, request.row)
          : !isLive(request.rel, request.row)
      if (achieved) {
        if (!options.minimize) return { status: 'ok', changes: applied, rounds }
        // Roll back to where we started, then rebuild the smallest set that
        // still works. Each trial is an apply/advance/rollback on the live
        // graph, which is what makes trying n of them affordable.
        applyChanges(applied, -1)
        const kept = shrink(applied, (subset) => {
          applyChanges(subset)
          const stillWorks = isUpdate
            ? isLive(request.rel, request.newRow!)
            : isInsert
              ? isLive(request.rel, request.row)
              : !isLive(request.rel, request.row)
          applyChanges(subset, -1)
          return stillWorks
        })
        applyChanges(kept)
        return { status: 'ok', changes: kept, rounds }
      }

      // An update or insert gets one shot: re-requesting would chase a row that
      // no longer exists, or already does. A delete iterates, since negation
      // genuinely needs another pass.
      if (isUpdate || isInsert) {
        // Read the wreckage before undoing it: `collateral` compares what the
        // change removed against what the row needed, and one of those two
        // states disappears on rollback.
        const after = isUpdate ? liveSnapshot() : null
        applyChanges(applied, -1)
        return {
          status: 'unsatisfied',
          attempted: applied,
          reason: isInsert
            ? `the insert did not produce ${request.rel}(${request.row.join(', ')}) — ` +
              'the rule cannot be satisfied by adding facts alone'
            : `the rewrite did not produce ${request.rel}(${request.newRow!.join(', ')})` +
              collateral(program, before!, after!, request.rel),
        }
      }
    }

    applyChanges(applied, -1)
    return {
      status: 'unsatisfied',
      attempted: applied,
      reason: `the row survived ${maxRounds} rounds of retraction`,
    }
  }

  return {
    update,
    advance: () => session.advance(),
    rows,
    propose,
    resolve,
    emissions: () => emissions,
    close: () => session.close(),
  }
}
