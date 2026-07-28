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
// Speculation works the same way. Apply the proposed EDB changes, advance, ask
// whether the view moved; if it didn't, apply the inverse and the session is
// unpoisoned. That is the propose → apply → verify → commit-or-rollback protocol
// with the rollback made cheap by the same mechanism as everything else.

import type { Program } from '../ast/index.js'
import { type ProgramSession, openSession } from '../executing/dataflow.js'
import type { Row } from '../reading/row.js'
import { inferRelationTypes } from '../typing/index.js'
import { SEED_PREFIX, SEED_UPD_PREFIX, compileShadow } from './compile.js'
import { validateRequest } from './validate.js'
import {
  type BackwardRequest,
  type Change,
  type Resolution,
  type ResolveOptions,
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

  const seedRel = (request: BackwardRequest): string =>
    request.newRow !== undefined
      ? `${SEED_UPD_PREFIX}${request.rel}`
      : `${SEED_PREFIX}${request.rel}`

  const seedRow = (request: BackwardRequest): Row =>
    request.newRow !== undefined ? [...request.row, ...request.newRow] : request.row

  const propose = (request: BackwardRequest): Change[] => {
    // `propose` is the raw primitive, so a malformed request is a caller bug
    // and throws. `resolve` turns the same message into a `refused` status,
    // because there it is one outcome among several.
    const malformed = validateRequest(program, inferred, shadow.seeds, request)
    if (malformed) throw new Error(malformed)
    const rel = seedRel(request)
    const row = seedRow(request)
    update(rel, row, 1)
    session.advance()
    const changes = readChannels()
    // Un-seed, so the next request starts from a clean channel set.
    update(rel, row, -1)
    session.advance()
    return changes
  }

  /** Apply changes to the session; `sign = -1` inverts them for a rollback. */
  const applyChanges = (changes: readonly Change[], sign = 1): void => {
    for (const c of changes) {
      if (c.kind === 'del') update(c.rel, c.row, -sign)
      else if (c.kind === 'ins') update(c.rel, c.row, sign)
      else {
        update(c.rel, c.row, -sign)
        update(c.rel, c.newRow!, sign)
      }
    }
    session.advance()
  }

  const isLive = (rel: string, row: Row): boolean => {
    const m = state.get(rel)
    const e = m?.get(keyOf(row))
    return (e?.n ?? 0) > 0
  }

  const resolve = (request: BackwardRequest): Resolution => {
    const malformed = validateRequest(program, inferred, shadow.seeds, request)
    if (malformed) return { status: 'refused', reason: malformed }
    if (!isLive(request.rel, request.row)) {
      return {
        status: 'refused',
        reason: `${request.rel}(${request.row.join(', ')}) is not derived from the current facts (stale?)`,
      }
    }

    const isUpdate = request.newRow !== undefined
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
              ? `no candidate change reaches a source relation for ${request.rel}`
              : 'no further candidates',
        }
      }
      if (rounds === 1 && options.requireUnambiguous) {
        const rels = new Set(changes.map((c) => c.rel))
        if (rels.size > 1 || changes.length > 1) {
          return {
            status: 'ambiguous',
            candidates: changes,
            reason:
              rels.size > 1
                ? `the request reaches ${rels.size} source relations (${[...rels].join(', ')})`
                : `${changes.length} tuples of ${[...rels][0]} could be changed`,
          }
        }
      }

      applyChanges(changes)
      applied.push(...changes)

      const achieved = isUpdate
        ? isLive(request.rel, request.newRow!)
        : !isLive(request.rel, request.row)
      if (achieved) return { status: 'ok', changes: applied, rounds }

      // An update gets one shot: re-requesting would chase a row that no longer
      // exists. A delete iterates, since negation genuinely needs another pass.
      if (isUpdate) {
        applyChanges(applied, -1)
        return {
          status: 'unsatisfied',
          attempted: applied,
          reason:
            `the rewrite did not produce ${request.rel}(${request.newRow!.join(', ')}) — ` +
            'a source tuple it changed is also relied on elsewhere in the rule',
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
