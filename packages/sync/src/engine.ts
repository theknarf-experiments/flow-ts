// The public SyncEngine: a transport-agnostic, generic-over-EDBs
// engine that holds a local MST of synced facts and drives a session
// per attached peer.
//
// Caller responsibilities (no React, no flow-ts Store coupling — just
// the bare data plumbing):
//   * Call `engine.add(rel, row)` whenever the local Store gains a
//     fact in a synced relation.
//   * Subscribe to `engine.onRemoteAdd` and write each (rel, row)
//     back into the local Store.
//   * Bring a Transport per peer and call `engine.attachPeer(t)`.
//     The engine handles the initial reconcile round and gossips
//     subsequent local writes as PUSH messages.
//
// What the engine deliberately doesn't do (v1):
//   * No retraction. Synced relations are sets of immutable facts
//     (multiplicity 1). CRDT semantics — including tombstone-as-fact
//     — live in the caller's Datalog program.
//   * No persistence. State is in-memory; reattaching after a process
//     restart replays from scratch.
//   * No multi-peer fan-in conflict resolution beyond "merge set
//     unions" — peers just contribute keys.

import { decodeRow, encodeRow, type Row } from 'flow-ts'
import { compareHash, Mst, serialisePageRanges, toHex, type Hash } from './mst/index.js'
import { factKey } from './protocol/payload.js'
import { SyncSession, type RetryOptions } from './protocol/session.js'
import type { Transport, Unsubscribe } from './transport/index.js'

export interface SyncEngineOptions {
  /** Bytes identifying this replica. Embedded in HELLO; not used
   *  semantically yet (v2 will use it for ordering / identity). */
  replicaId: Uint8Array
  /** Relation names the engine will sync. Facts in any other
   *  relation are ignored by `add()`. */
  relations: readonly string[]
}

export type RemoteAddListener = (relation: string, row: Row) => void

/** Public handle for an attached peer. Resolves to the post-initial
 *  reconcile state via `synced`. */
export interface PeerHandle {
  /** Resolves when the initial reconcile round between this peer and
   *  the local engine completes. */
  readonly synced: Promise<void>
  /** Tear down this peer's session and close the transport. */
  detach(): void
}

export class SyncEngine {
  readonly #replicaId: Uint8Array
  readonly #relations: Set<string>
  readonly #mst = new Mst()
  /** key (hex) → (relation, encodedRow). One entry per fact. */
  readonly #facts = new Map<string, { relation: string; encodedRow: string }>()
  readonly #listeners = new Set<RemoteAddListener>()
  readonly #peers = new Set<PeerEntry>()

  constructor(opts: SyncEngineOptions) {
    this.#replicaId = opts.replicaId
    this.#relations = new Set(opts.relations)
  }

  /** Register a fact from the local Store. Idempotent: re-adding a
   *  known fact is a no-op. Facts in unsynced relations are
   *  silently dropped (the caller doesn't have to filter). */
  add(relation: string, row: Row): void {
    if (!this.#relations.has(relation)) return
    const encodedRow = encodeRow(row)
    const key = factKey(relation, encodedRow)
    const hex = toHex(key)
    if (this.#facts.has(hex)) return
    this.#mst.insert(key)
    this.#facts.set(hex, { relation, encodedRow })
    // Gossip to every attached peer. We previously gated this on
    // `entry.synced=true`, but that created a race: if add() fired
    // during the .then() microtask before `entry.synced` flipped,
    // the new fact missed both the in-flight PAGE_RANGES (already
    // sent without it) AND the PUSH path. The session's onPush
    // handler is robust to PUSH arriving at any time after start(),
    // so it's safe to push unconditionally — mid-round PUSH just
    // arrives alongside the round's other messages.
    for (const p of this.#peers) {
      p.session.push([{ relation, encodedRow }])
    }
  }

  /** Subscribe to facts surfaced from peers (initial sync OR PUSH).
   *  Caller writes each (rel, row) into its Store. */
  onRemoteAdd(fn: RemoteAddListener): Unsubscribe {
    this.#listeners.add(fn)
    return () => {
      this.#listeners.delete(fn)
    }
  }

  /** Total fact count, across all synced relations. */
  get size(): number {
    return this.#facts.size
  }

  /** Local root digest. Two engines with the same fact set have
   *  identical roots; the protocol uses this as a "are we even out
   *  of sync?" gate. */
  rootDigest(): Hash {
    return this.#mst.rootDigest()
  }

  attachPeer(transport: Transport, opts?: { retry?: RetryOptions }): PeerHandle {
    const entry: PeerEntry = { session: null as unknown as SyncSession, synced: false }
    const session = new SyncSession(transport, {
      replicaId: this.#replicaId,
      localKeysSorted: () => {
        const keys = [...this.#mst.keys()]
        keys.sort(compareHash)
        return keys
      },
      localPageRanges: () => serialisePageRanges(this.#mst.root()),
      localRoot: () => this.#mst.rootDigest(),
      lookupFact: (k) => this.#facts.get(toHex(k)) ?? null,
      onRemoteFact: (relation, encodedRow) =>
        this.#applyRemote(relation, encodedRow, entry),
      ...(opts?.retry !== undefined ? { retry: opts.retry } : {}),
    })
    entry.session = session
    this.#peers.add(entry)
    session.start()
    session.completion.then(
      () => {
        entry.synced = true
      },
      () => {
        this.#peers.delete(entry)
      },
    )
    return {
      synced: session.completion,
      detach: () => {
        this.#peers.delete(entry)
        session.close()
      },
    }
  }

  #applyRemote(relation: string, encodedRow: string, from?: PeerEntry): void {
    if (!this.#relations.has(relation)) return // peer pushed an unsynced relation; drop
    const key = factKey(relation, encodedRow)
    const hex = toHex(key)
    if (this.#facts.has(hex)) return // already had it
    this.#mst.insert(key)
    this.#facts.set(hex, { relation, encodedRow })
    // Relay to every peer except the sender. A hub engine with no
    // local writer (like the kanban server) otherwise never forwards
    // facts it learns from one peer to the others — they'd only
    // converge on the next full reconcile. Loops can't happen: we
    // only relay facts that were new to this engine.
    for (const p of this.#peers) {
      if (p === from) continue
      p.session.push([{ relation, encodedRow }])
    }
    let row: Row
    try {
      row = decodeRow(encodedRow)
    } catch {
      return // malformed encoded row — drop silently
    }
    for (const fn of this.#listeners) {
      // Isolate listener exceptions: one buggy listener must not
      // break sibling listeners or fail the session.
      try {
        fn(relation, row)
      } catch (e) {
        // Surface on console so the user notices a bug, but swallow
        // the throw so the engine and session keep working.
        // eslint-disable-next-line no-console
        if (typeof console !== 'undefined' && console.error) {
          console.error('[@flow-ts/sync] onRemoteAdd listener threw:', e)
        }
      }
    }
  }
}

interface PeerEntry {
  session: SyncSession
  synced: boolean
}
