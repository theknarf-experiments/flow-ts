// React bindings for the flow-ts Datalog runtime, inspired by Tanstack
// DB's Collection / live-query split.
//
// One `Store` wraps a single `openSession` from `@flow-ts/executing`.
// Each `Collection` is a typed handle to one EDB you can `insert` /
// `delete` rows on. Each IDB head is materialised internally as a set
// of live rows, and `useLiveQuery(store, idbName)` is a React hook
// that subscribes to that set and re-renders the component whenever
// it changes. `useProgram(store)` re-renders on program swaps so
// schema-driven UI (e.g. inspectors) picks up rule edits.
//
// Updates auto-batch. Multiple `collection.insert(...)` calls in the
// same tick are queued together; we drive `session.advance()` on the
// next microtask, then notify React subscribers once. This means a
// flurry of writes (e.g. seeding from a JSON blob) produces a single
// render, not one per row.

import { useSyncExternalStore } from 'react'
import { openSession, type Program, type ProgramSession } from 'flow-ts'
import { encodeRow, type Row } from 'flow-ts'

type Listener = () => void

/** A single IDB head's live state: row-key → row tuple with positive
 *  net multiplicity. The keys are stable per row content so React's
 *  identity-based reconciliation works when we hand the same row
 *  reference back across ticks. */
class RelationState {
  /** Composite key (`encodeRow(row)`) → live row tuple. Excludes any
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
  #program: Program
  #relations = new Map<string, RelationState>()
  /** Authoritative store of EDB rows the user has inserted, keyed by
   *  relation name → encoded row → row tuple. Survives `replaceProgram`
   *  so a user can iterate on rules without losing their EDB inputs,
   *  even if the rule edit briefly drops some relations from the
   *  program. Mutated only via `update()` (which knows the row passed
   *  the session validation) and used to seed replays. */
  #edbRows = new Map<string, Map<string, Row>>()
  /** Microtask flush guard. Set when an update is queued; cleared when
   *  the microtask runs. */
  #scheduled = false
  /** Set of relations touched during the in-progress tick. Used to
   *  decide which listener sets to notify after `advance()`. */
  #touchedThisTick = new Set<string>()
  /** Subscribers notified whenever `replaceProgram` swaps the rules. */
  #programListeners = new Set<Listener>()

  constructor(program: Program) {
    this.#program = program
    // The sink only fires for IDB heads — the executor doesn't echo EDB
    // writes back through it. EDB live state is mirrored directly by
    // `update()` below so `useLiveQuery` on an EDB still works.
    this.#session = openSession(program, {}, (rel, row, diff) => {
      this.#queueDiff(rel, row, diff)
    })
  }

  /** Current parsed Program. Stable per session; changes only via
   *  `replaceProgram`. Read by the inspector to know what schemas to
   *  render. */
  get program(): Program {
    return this.#program
  }

  /** Subscribe to program swaps. The listener fires once per successful
   *  `replaceProgram`, after the new session has flushed its initial
   *  derivations. */
  subscribeProgram(listener: Listener): () => void {
    this.#programListeners.add(listener)
    return () => {
      this.#programListeners.delete(listener)
    }
  }

  /** Swap the running program. Closes the old session, opens a new one
   *  with the new rules, and replays every authoritative EDB row whose
   *  relation still exists as an EDB (with matching arity) in the new
   *  program. IDB derivations rebuild from those replayed inputs.
   *
   *  EDB rows for relations *not* in the new program stay parked in
   *  `#edbRows` — if a later `replaceProgram` re-introduces the
   *  relation, those rows come back automatically. Mismatched-arity
   *  rows are skipped silently rather than crashing the replay. */
  replaceProgram(newProgram: Program): void {
    // 1. Flush any in-flight writes so the old session's IDB derivations
    //    don't leak into the new one through stale sink invocations.
    this.#flushNow()

    // 2. Tear down the old session. `close()` runs one final advance;
    //    we don't care about diffs it might produce since we're about
    //    to wipe the derived state anyway.
    try {
      this.#session.close()
    } catch {
      // session already closed — ignore
    }

    // 3. Wipe every mirror so subscribers don't see stale rows post-
    //    swap. Remember which ones had a non-empty snapshot so we can
    //    fire their listeners even when the new program leaves them
    //    empty. (The authoritative EDB rows live in `#edbRows`, which
    //    we don't touch — those persist across rebuilds.)
    const toNotify = new Set<string>()
    for (const [name, state] of this.#relations) {
      if (state.snapshot.length > 0) toNotify.add(name)
      state.rows.clear()
      state.pending.clear()
      state.snapshot = []
    }

    // 4. Open the new session against the new program.
    this.#program = newProgram
    this.#session = openSession(newProgram, {}, (rel, row, diff) => {
      this.#queueDiff(rel, row, diff)
    })

    // 5. Replay authoritative EDB rows that fit. Iterating `newProgram.edbs`
    //    (rather than every name in `#edbRows`) ensures we don't try to
    //    insert into IDBs or undeclared relations.
    for (const edb of newProgram.edbs) {
      const bucket = this.#edbRows.get(edb.name)
      if (!bucket) continue
      const arity = edb.arity()
      for (const row of bucket.values()) {
        if (row.length !== arity) continue
        try {
          this.#session.update(edb.name, row, +1)
          this.#queueDiff(edb.name, row, +1)
        } catch {
          // row rejected — skip silently so one bad row doesn't poison
          // the rest of the replay
        }
      }
    }

    // 6. Drive the new graph to fixpoint over the replayed EDB state
    //    and notify both per-relation and program-level subscribers.
    this.#flushNow()
    for (const name of toNotify) {
      const state = this.#relations.get(name)
      if (state) for (const l of state.listeners) l()
    }
    for (const l of this.#programListeners) l()
  }

  #queueDiff(rel: string, row: Row, diff: number): void {
    const state = this.#getState(rel)
    // Use the same encoding as the executor so a row containing `,` or `\`
    // in a string column can't collide with a different row.
    const key = encodeRow(row)
    const existing = state.pending.get(key)
    if (existing) {
      existing[1] += diff
    } else {
      state.pending.set(key, [[...row], diff])
    }
    this.#touchedThisTick.add(rel)
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

  /** Queue an EDB update. Used by `Collection`. Mirrors the diff
   *  locally so EDB live queries see the change — the executor only
   *  emits sink callbacks for IDB heads. */
  update(relation: string, row: Row, diff: number): void {
    // Validate first — if `session.update` throws (unknown relation,
    // closed session, etc.) we don't want to mutate any local state.
    this.#session.update(relation, row, diff)
    // Track the row authoritatively so a future `replaceProgram` can
    // replay it even if the user briefly swaps in a program that
    // doesn't declare this relation.
    const key = encodeRow(row)
    let bucket = this.#edbRows.get(relation)
    if (!bucket) {
      bucket = new Map()
      this.#edbRows.set(relation, bucket)
    }
    if (diff > 0) {
      if (!bucket.has(key)) bucket.set(key, row)
    } else if (diff < 0) {
      bucket.delete(key)
    }
    this.#queueDiff(relation, row, diff)
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

/**
 * React hook: re-render when the store swaps program. Returns the
 * currently-active parsed `Program`. The reference is stable until the
 * next `replaceProgram` call, so it's safe to use as a dep.
 */
export function useProgram(store: Store): Program {
  return useSyncExternalStore(
    (cb) => store.subscribeProgram(cb),
    () => store.program,
    () => store.program,
  )
}
