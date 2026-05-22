// Simulated network sync between two flow-ts `Store` instances.
//
// Each store owns its own session and EDB state. The sync link
// subscribes to a configured set of EDB relations on both sides; when
// new rows appear on one side, they're queued for delivery to the
// other after a configurable delay. Per-replica `online` flags gate
// both sending and receiving — flipping a replica offline parks all
// in-flight and locally-emitted ops until it comes back online.
//
// The CRDT op log is monotonic in this demo (Insert / Remove are
// append-only — Remove tombstones characters but the EDBs themselves
// only grow), so "new rows" = "ops the other replica hasn't seen
// yet". We track that per direction with a `known` set keyed by
// `<relation>|<encodedRow>`.
//
// IMPORTANT: this layer sits entirely on top of the public Store API
// (`subscribe`, `snapshot`, `update`). It never reaches into Store
// internals — the same primitives a user has.

import { encodeRow, type Row } from 'flow-ts'
import type { Store } from '@flow-ts/react'

export type ReplicaId = 'a' | 'b'

interface PendingOp {
  relation: string
  row: Row
  /** Wall-clock timestamp the op became eligible for delivery. */
  eligibleAt: number
}

type Listener = () => void

export interface SyncSnapshot {
  online: { a: boolean; b: boolean }
  delay: { a: number; b: number }
  queueAtoB: number
  queueBtoA: number
}

export class SyncLink {
  #storeA: Store
  #storeB: Store
  #relations: string[]

  #online = { a: true, b: true }
  /** Outbound delay in ms — how long an op produced at this replica
   *  takes to reach the other side. */
  #delay = { a: 250, b: 250 }

  /** Queues of ops waiting for delivery, in arrival order. */
  #queueAtoB: PendingOp[] = []
  #queueBtoA: PendingOp[] = []

  /** Per-direction dedup: "we've already seen this row in store X and
   *  scheduled delivery of it to store Y." Prevents the snapshot
   *  callback from re-enqueueing rows on every fire. */
  #knownInA = new Set<string>()
  #knownInB = new Set<string>()

  /** Pending setTimeout handles per direction, so we can cancel
   *  in-flight deliveries when a replica goes offline. */
  #timerAtoB: ReturnType<typeof setTimeout> | null = null
  #timerBtoA: ReturnType<typeof setTimeout> | null = null

  /** State subscribers — the React layer wires its UI to these. */
  #listeners = new Set<Listener>()
  /** Cached snapshot. Identity changes only when state actually
   *  changes, so `useSyncExternalStore` doesn't loop on every render. */
  #snapshot: SyncSnapshot

  constructor(storeA: Store, storeB: Store, relations: string[]) {
    this.#storeA = storeA
    this.#storeB = storeB
    this.#relations = relations
    // Seed the known sets with whatever's already in each store
    // (typically empty for a fresh demo).
    for (const rel of relations) {
      for (const row of storeA.snapshot(rel)) this.#knownInA.add(this.#key(rel, row))
      for (const row of storeB.snapshot(rel)) this.#knownInB.add(this.#key(rel, row))
      storeA.subscribe(rel, () => this.#scan('a', rel))
      storeB.subscribe(rel, () => this.#scan('b', rel))
    }
    this.#snapshot = this.#buildSnapshot()
  }

  /** Subscribe to sync state changes (online flags, delays, queue
   *  sizes). Returns an unsubscribe. */
  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** Stable snapshot reference — identity changes only when state
   *  changes. Safe to feed to `useSyncExternalStore`. */
  snapshot(): SyncSnapshot {
    return this.#snapshot
  }

  #buildSnapshot(): SyncSnapshot {
    return {
      online: { ...this.#online },
      delay: { ...this.#delay },
      queueAtoB: this.#queueAtoB.length,
      queueBtoA: this.#queueBtoA.length,
    }
  }

  setOnline(peer: ReplicaId, online: boolean): void {
    if (this.#online[peer] === online) return
    this.#online[peer] = online
    if (online) {
      this.#scheduleDrain()
    } else {
      // Cancel any in-flight delivery timers; the queue stays put.
      if (peer === 'a') {
        if (this.#timerAtoB) clearTimeout(this.#timerAtoB)
        this.#timerAtoB = null
      } else {
        if (this.#timerBtoA) clearTimeout(this.#timerBtoA)
        this.#timerBtoA = null
      }
    }
    this.#emit()
  }

  setDelay(peer: ReplicaId, delayMs: number): void {
    this.#delay[peer] = Math.max(0, delayMs)
    this.#emit()
  }

  // -------------------------------------------------------------------

  #key(rel: string, row: Row): string {
    return `${rel}|${encodeRow(row)}`
  }

  /** Scan a store's snapshot for newly-seen rows; queue any that
   *  haven't been forwarded yet. Called from the per-relation
   *  subscribe callback. */
  #scan(peer: ReplicaId, rel: string): void {
    const store = peer === 'a' ? this.#storeA : this.#storeB
    const knownLocal = peer === 'a' ? this.#knownInA : this.#knownInB
    const queue = peer === 'a' ? this.#queueAtoB : this.#queueBtoA
    const delay = this.#delay[peer]

    for (const row of store.snapshot(rel)) {
      const key = this.#key(rel, row)
      if (knownLocal.has(key)) continue
      knownLocal.add(key)
      queue.push({ relation: rel, row, eligibleAt: Date.now() + delay })
    }
    this.#emit()
    this.#scheduleDrain()
  }

  #scheduleDrain(): void {
    this.#scheduleDirection('a')
    this.#scheduleDirection('b')
  }

  /** Schedule the next delivery from `source` to the other replica, if
   *  one is due and both ends are online. Each call is idempotent —
   *  if a timer's already running, we leave it alone. */
  #scheduleDirection(source: ReplicaId): void {
    const target: ReplicaId = source === 'a' ? 'b' : 'a'
    const queue = source === 'a' ? this.#queueAtoB : this.#queueBtoA
    const timerProp = source === 'a' ? '#timerAtoB' : '#timerBtoA'

    if (!this.#online[source] || !this.#online[target]) return
    if (queue.length === 0) return
    if (source === 'a' ? this.#timerAtoB : this.#timerBtoA) return

    const head = queue[0]!
    const waitMs = Math.max(0, head.eligibleAt - Date.now())
    const handle = setTimeout(() => {
      if (source === 'a') this.#timerAtoB = null
      else this.#timerBtoA = null
      this.#deliverOne(source)
      // Loop on the next op (if any), respecting current online state.
      this.#scheduleDirection(source)
    }, waitMs)
    if (source === 'a') this.#timerAtoB = handle
    else this.#timerBtoA = handle
    // Silence unused var warning — referenced through the closure above.
    void timerProp
  }

  #deliverOne(source: ReplicaId): void {
    const target: ReplicaId = source === 'a' ? 'b' : 'a'
    const queue = source === 'a' ? this.#queueAtoB : this.#queueBtoA
    const targetStore = target === 'a' ? this.#storeA : this.#storeB
    const knownTarget = target === 'a' ? this.#knownInA : this.#knownInB

    if (!this.#online[source] || !this.#online[target]) return
    const op = queue.shift()
    if (!op) return

    // Mark as known on the target FIRST so the target's subscribe
    // callback (which will fire when the snapshot updates) doesn't
    // turn around and queue this same row back to us.
    knownTarget.add(this.#key(op.relation, op.row))
    try {
      targetStore.update(op.relation, op.row, +1)
    } catch {
      // Target may have closed (e.g. during a program reload). Drop
      // the op silently — the queue is now drained.
    }
    this.#emit()
  }

  #emit(): void {
    this.#snapshot = this.#buildSnapshot()
    for (const listener of this.#listeners) listener()
  }
}
