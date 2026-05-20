// React-friendly Datalog store, inspired by Tanstack DB's
// Collection / live-query split.
//
// One `Store` wraps a single `openSession` from `@flow-ts/executing`.
// Each `Collection` is a typed handle to one EDB you can `insert` /
// `delete` rows on. Each IDB head is materialised internally as a set
// of live rows, and `useLiveQuery(store, idbName)` is a React hook
// that subscribes to that set and re-renders the component whenever
// it changes.
//
// Updates auto-batch. Multiple `collection.insert(...)` calls in the
// same tick are queued together; we drive `session.advance()` on the
// next microtask, then notify React subscribers once. This means a
// flurry of writes (e.g. seeding from a JSON blob) produces a single
// render, not one per row.

import { useSyncExternalStore } from 'react'
import { openSession, type ProgramSession } from '@flow-ts/executing'
import type { Program } from '@flow-ts/parsing'
import type { Row } from '@flow-ts/reading'

type Listener = () => void

/** A single IDB head's live state: row-key → row tuple with positive
 *  net multiplicity. The keys are stable per row content so React's
 *  identity-based reconciliation works when we hand the same row
 *  reference back across ticks. */
class RelationState {
  /** Composite key (`row.join(',')`) → live row tuple. Excludes any
   *  row whose net multiplicity dropped to zero. */
  readonly rows = new Map<string, Row>()
  /** Listeners (React subscribers) attached via `subscribe()`. */
  readonly listeners = new Set<Listener>()
  /** Snapshot identity. Returned by `useSyncExternalStore`'s
   *  getSnapshot — we hand back a fresh array reference each time
   *  the row set changes so React picks up the diff. */
  snapshot: ReadonlyArray<Row> = []
  /** Diff buffer per tick. Positive net counts move row into `rows`;
   *  zero/negative net counts remove it. Resolved by `flush()`. */
  pending = new Map<string, [Row, number]>()
}

export class Store {
  #session: ProgramSession
  #relations = new Map<string, RelationState>()
  /** Microtask flush guard. Set when an update is queued; cleared when
   *  the microtask runs. */
  #scheduled = false
  /** Set of relations touched during the in-progress tick. Used to
   *  decide which listener sets to notify after `advance()`. */
  #touchedThisTick = new Set<string>()

  constructor(program: Program) {
    this.#session = openSession(program, {}, (rel, row, diff) => {
      const state = this.#getState(rel)
      const key = row.map((v) => v.toString()).join(',')
      const existing = state.pending.get(key)
      if (existing) {
        existing[1] += diff
      } else {
        state.pending.set(key, [[...row], diff])
      }
      this.#touchedThisTick.add(rel)
    })
  }

  /** Create a typed handle to an EDB. The EDB must be declared in the
   *  program. Multiple collections for the same EDB are allowed and
   *  share state. */
  collection<T extends Row>(name: string): Collection<T> {
    return new Collection<T>(this, name)
  }

  /** Subscribe to changes in an IDB relation. Returns an unsubscribe. */
  subscribe(relation: string, listener: Listener): () => void {
    const state = this.#getState(relation)
    state.listeners.add(listener)
    return () => {
      state.listeners.delete(listener)
    }
  }

  /** Current snapshot of an IDB relation's live rows. Stable array
   *  identity across ticks where the row set doesn't change — safe to
   *  feed `useSyncExternalStore`. */
  snapshot(relation: string): ReadonlyArray<Row> {
    return this.#getState(relation).snapshot
  }

  /** Queue an EDB update. Used by `Collection`. */
  update(relation: string, row: Row, diff: number): void {
    this.#session.update(relation, row, diff)
    this.#schedule()
  }

  /** Force a synchronous flush. Useful from tests; React code generally
   *  doesn't need it — the microtask flush is enough. */
  flush(): void {
    this.#flushNow()
  }

  // -------------------------------------------------------------------

  #getState(rel: string): RelationState {
    let state = this.#relations.get(rel)
    if (!state) {
      state = new RelationState()
      this.#relations.set(rel, state)
    }
    return state
  }

  #schedule(): void {
    if (this.#scheduled) return
    this.#scheduled = true
    queueMicrotask(() => this.#flushNow())
  }

  #flushNow(): void {
    this.#scheduled = false
    this.#session.advance()
    // Apply the diffs gathered by the sink, then notify listeners for
    // each relation whose row set actually changed.
    const changed = new Set<string>()
    for (const rel of this.#touchedThisTick) {
      const state = this.#getState(rel)
      let mutated = false
      for (const [key, [row, delta]] of state.pending) {
        const had = state.rows.has(key)
        if (delta <= 0) {
          if (had) {
            state.rows.delete(key)
            mutated = true
          }
        } else {
          if (!had) {
            state.rows.set(key, row)
            mutated = true
          }
        }
      }
      state.pending.clear()
      if (mutated) {
        state.snapshot = [...state.rows.values()]
        changed.add(rel)
      }
    }
    this.#touchedThisTick.clear()
    for (const rel of changed) {
      const state = this.#getState(rel)
      for (const l of state.listeners) l()
    }
  }
}

/**
 * Typed EDB handle. `insert` adds a row, `delete` removes one. Updates
 * are batched — call them as often as you like and React renders
 * exactly once per microtask.
 */
export class Collection<T extends Row> {
  constructor(
    private readonly store: Store,
    public readonly name: string,
  ) {}

  insert(row: T): void {
    this.store.update(this.name, row, +1)
  }

  delete(row: T): void {
    this.store.update(this.name, row, -1)
  }
}

/**
 * React hook: subscribe to an IDB relation's live row set. Returns a
 * stable array reference per tick (changes only when the row set
 * actually changes) so memoised list children stay stable.
 */
export function useLiveQuery<T extends Row>(
  store: Store,
  relation: string,
): ReadonlyArray<T> {
  return useSyncExternalStore(
    (cb) => store.subscribe(relation, cb),
    () => store.snapshot(relation),
    () => store.snapshot(relation),
  ) as ReadonlyArray<T>
}
