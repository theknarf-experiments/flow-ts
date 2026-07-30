// React bindings for the flow-ts Datalog runtime, inspired by Tanstack
// DB's Collection / live-query split.
//
// One `Store` wraps a single `openSession` from `flow-ts`.
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

import { useMemo, useSyncExternalStore } from 'react'
import {
  type Program,
  type ProgramSession,
  executeProgram,
  openSession,
} from 'flow-ts'
import { encodeRow, type Row } from 'flow-ts'
import {
  type BackwardRequest,
  type BackwardSession,
  type PutPolicy,
  type Resolution,
  type ShadowChannel,
  compileShadow,
  openBackwardSession,
} from 'flow-ts'
import { parseProgram } from 'flow-ts'

export interface StoreOptions {
  /** Views an edit can be written back through. Opt-in, and deliberately so.
   *
   *  Shadow rules replay their rule's body, which forces joins — and the
   *  indexes behind them — on relations the forward program never needed
   *  indexed that way. Measured, that is about 1.8x to stand the graph up and
   *  about 3x per incremental step, the latter on a base of a few microseconds
   *  and flat in data size (`pnpm bench`) — a constant factor on the cheap
   *  operation, not the doubling of everything an earlier version of this
   *  comment claimed.
   *
   *  In this store it is cheaper still, because nothing is compiled until an
   *  edit is actually made: each write resolves against a freshly compiled
   *  shadow program and throws it away, so listing a view here costs nothing
   *  until someone writes through it. That trade is the opposite one — see the
   *  note on `#write` — and it is not obviously right for every consumer. */
  writable?: readonly string[]
  /** Backward-direction policies for the cases the rules don't determine — how
   *  to spread an aggregate, which side of a join to write, what to supply for
   *  a value an insert has no row to recover.
   *
   *  Usually better stated in the program itself, with `.put`, since it is a
   *  property of the schema rather than of one consumer. This is here for
   *  trying a policy against a program you don't own, and overrides the
   *  directive when both are present. */
  put?: Record<string, PutPolicy>
  /** Which request channels to compile. Omitted means all three.
   *
   *  The second axis of the same trade as `writable`, and the one worth
   *  reaching for when a UI's writes are all of one kind. A table of editable
   *  cells only ever sends `upd`; compiling `del` and `ins` for it builds rules
   *  nothing will seed. Deletion is the dearest of the three, because it fans
   *  out over every rule of a head rather than picking one.
   *
   *  A request on a channel that wasn't compiled is refused by name, so a
   *  narrowed store fails loudly rather than looking like it found nothing. */
  channels?: readonly ShadowChannel[]
}

/** Knobs for one edit, passed straight through to `resolveBackward`. */
export interface WriteOptions {
  /** Report `ambiguous` rather than applying every candidate when the request
   *  reaches more than one source relation. */
  requireUnambiguous?: boolean
  /** Shrink the result to a set with no redundant member. */
  minimize?: boolean
  /** Work out the changes but don't apply them.
   *
   *  For a consumer whose source of truth isn't the EDB — a file, a CRDT, a
   *  server — the engine's answer is an instruction to carry out elsewhere,
   *  and applying it here as well would double-count. `resolution.changes`
   *  names facts, so the caller can rewrite whatever those facts came from
   *  and feed the result back through the ordinary read path. */
  dryRun?: boolean
}

type Listener = () => void

/** A single IDB head's live state: row-key → row tuple with positive
 *  net multiplicity. The keys are stable per row content so React's
 *  identity-based reconciliation works when we hand the same row
 *  reference back across ticks. */
class RelationState {
  /** Composite key (`encodeRow(row)`) → live row tuple. Excludes any
   *  row whose net multiplicity dropped to zero. */
  readonly rows = new Map<string, Row>()
  /** Running multiplicity per row, across every tick.
   *
   *  Presence can't be derived from one tick's diff alone. A row with two
   *  derivations, one of which is retracted, is emitted `-1` and `+1` in the
   *  *same* advance — deleting `docs → api` from a link graph retracts
   *  `Reach(home, api)` by that path and re-derives it via the other one. Read
   *  as a per-tick net that is zero, so treating "not positive this tick" as
   *  "gone" drops a row that is still live. Kept as a running total, it is
   *  1 - 1 + 1 = 1 and the row stays.
   *
   *  Entries at exactly zero are dropped, since a fresh key reads as zero
   *  anyway and a long-lived store would otherwise accumulate one per row it
   *  ever held. Negative entries are kept: a row retracted more often than it
   *  was derived would come back on the next `+1` if the debt were forgotten,
   *  and quietly resurrecting a row is worse than holding a small map. */
  readonly counts = new Map<string, number>()
  /** Listeners (React subscribers) attached via `subscribe()`. */
  readonly listeners = new Set<Listener>()
  /** Snapshot identity. Returned by `useSyncExternalStore`'s
   *  getSnapshot — we hand back a fresh array reference each time
   *  the row set changes so React picks up the diff. */
  snapshot: ReadonlyArray<Row> = []
  /** Diff buffer per tick, folded into `counts` by `flush()`. */
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

  readonly #writable: ReadonlySet<string>
  readonly #put: Record<string, PutPolicy>
  readonly #channels: readonly ShadowChannel[] | undefined
  /** The maintained backward graph. Null until the first write, so a store
   *  nobody writes through pays nothing for the option. */
  #backward: BackwardSession | null = null
  /** Per-view writable columns, computed once per program. */
  #writableColumns: Record<string, number[]> | null = null
  #edbVersion = 0

  constructor(program: Program, options: StoreOptions = {}) {
    this.#program = program
    this.#writable = new Set(options.writable ?? [])
    this.#put = options.put ?? {}
    this.#channels = options.channels
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
    // The shadow rules are compiled from the program, so they go with it.
    this.#closeBackward()

    // 3. Wipe every mirror so subscribers don't see stale rows post-
    //    swap. Remember which ones had a non-empty snapshot so we can
    //    fire their listeners even when the new program leaves them
    //    empty. (The authoritative EDB rows live in `#edbRows`, which
    //    we don't touch — those persist across rebuilds.)
    const toNotify = new Set<string>()
    for (const [name, state] of this.#relations) {
      if (state.snapshot.length > 0) toNotify.add(name)
      state.rows.clear()
      // The multiplicities belong to the old graph. Carrying them over would
      // add the replay's `+1`s to counts the new session never emitted.
      state.counts.clear()
      state.pending.clear()
      state.snapshot = []
    }

    // 4. Open the new session against the new program. Writability is a
    //    property of the rules, so the cached answer goes with them.
    this.#program = newProgram
    this.#writableColumns = null
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
   *  emits sink callbacks for IDB heads.
   *
   *  A store's EDBs are **sets**, not multisets. The session underneath is a
   *  Z-set and would happily carry `Link("home","docs")` at multiplicity 2,
   *  where one delete leaves it derived and one delete removes it from
   *  `#edbRows` — the table would show the row gone and everything derived
   *  from it still there. A UI has no vocabulary for "present twice", and
   *  `#edbRows` (which is what a `replaceProgram` replays) has never had one
   *  either. So a redundant insert or delete is dropped rather than forwarded,
   *  and the set is the single answer to what this store holds. */
  update(relation: string, row: Row, diff: number): void {
    const key = encodeRow(row)
    let bucket = this.#edbRows.get(relation)
    if (!bucket) {
      bucket = new Map()
      this.#edbRows.set(relation, bucket)
    }
    const had = bucket.has(key)
    const changes = diff > 0 ? !had : diff < 0 ? had : false
    if (!changes) {
      // Still ask the session, with a diff that does nothing, so an unknown
      // relation or a closed session throws exactly as it would for a call
      // that isn't a no-op. A quiet success here would be a worse bug than the
      // one this branch exists to avoid.
      this.#session.update(relation, row, 0)
      return
    }
    const signed = diff > 0 ? +1 : -1
    // Validate first — if `session.update` throws (unknown relation,
    // closed session, etc.) we don't want to mutate any local state.
    this.#session.update(relation, row, signed)
    // Track the row authoritatively so a future `replaceProgram` can
    // replay it even if the user briefly swaps in a program that
    // doesn't declare this relation.
    if (signed > 0) bucket.set(key, row)
    else bucket.delete(key)
    this.#queueDiff(relation, row, signed)
    this.#edbVersion++
    // Keep the backward graph in step. It only exists once somebody has
    // written, and an unknown relation there is one this program does not
    // declare — the same rows `replaceProgram` parks for a later rebuild.
    if (this.#backward) {
      try {
        this.#backward.update(relation, row, signed)
      } catch {
        // not an EDB of this program — ignore, as the forward path does
      }
    }
    this.#schedule()
  }

  /** Force a synchronous flush. Useful from tests; React code generally
   *  doesn't need it — the microtask flush is enough. */
  flush(): void {
    this.#flushNow()
  }

  /** Bumped whenever a source relation changes, so a consumer that depends on
   *  *all* of them has one value to compare rather than a set of snapshots. */
  edbVersion(): number {
    return this.#edbVersion
  }

  /** Run a program this store has never seen, over the facts it holds.
   *
   *  The source is the caller's declarations and rules; the source-relation
   *  declarations are prepended, so a query names them without restating their
   *  schemas — and gets every one the store knows, including relations put in
   *  directly rather than parsed from anywhere.
   *
   *  A throwaway evaluation, so it costs a batch run. `useAdHocQuery` is the
   *  React wrapper and the place the trade is explained. */
  runAdHoc(source: string): AdHocResult {
    const rows = new Map<string, Row[]>()
    const edbNames = new Set(this.#program.edbs.map((d) => d.name))
    // Built from the attributes rather than `RelDecl.toString()`, which
    // appends `read as <path>` — the `.input` clause inlined, and not
    // something a `.decl` line can carry.
    const declaration = (d: Program['edbs'][number]) =>
      `.decl ${d.name}(${d.attributes.map((a) => String(a)).join(', ')})\n.input ${d.name}.csv`
    const text = `.in\n${this.#program.edbs.map(declaration).join('\n\n')}\n\n${source}\n`

    let program: Program
    try {
      program = parseProgram(text, { grammarSource: 'ad-hoc.dl' })
    } catch (err) {
      return { rows, error: err instanceof Error ? err.message : String(err) }
    }

    const facts = new Map<string, Row[]>()
    for (const name of edbNames) {
      facts.set(name, [...(this.#edbRows.get(name)?.values() ?? [])])
    }
    try {
      executeProgram(program, facts, {}, (rel, row, diff) => {
        // Source relations are the input; echoing them back would bury the
        // answer under what was already known.
        if (diff <= 0 || edbNames.has(rel)) return
        const list = rows.get(rel)
        if (list) list.push([...row])
        else rows.set(rel, [[...row]])
      })
    } catch (err) {
      return { rows, error: err instanceof Error ? err.message : String(err) }
    }
    return { rows, error: null }
  }

  // --- writing back ----------------------------------------------------
  //
  // One graph over `program + shadow(program)`, opened on the first write and
  // kept in step from then on. A request costs the delta rather than a re-run:
  // measured against building and loading a graph per request, that is ~100x
  // at 200 rows and ~1700x at 4000, and the gap widens with the data because
  // one side scales with the database and the other with the request.
  //
  // Nothing is opened until an edit is actually made, so listing a view in
  // `writable` still costs nothing on its own — the trade only starts once
  // somebody writes. After that the shadow rules are maintained on every
  // forward change, which is about 1.8x to stand the graph up and about 3x per
  // incremental step, the latter on a base of a few microseconds and flat in
  // data size (`pnpm -F flow-ts run bench`). A constant factor on the cheap
  // operation, buying an asymptotic one on the dear operation.
  //
  // The session never commits. Changes come back as data and are applied
  // through this store's ordinary update path, which mirrors them straight
  // back into the session — so there is one way rows enter the graph, and the
  // EDB mirror, the live queries and the batching all behave exactly as they
  // do for a direct collection write.

  /** The backward graph, opened and back-filled on demand. */
  #backwardSession(): BackwardSession | null {
    if (this.#backward) return this.#backward
    if (this.#writable.size === 0) return null
    const session = openBackwardSession(this.#program, {
      views: [...this.#writable],
      put: this.#put,
      channels: this.#channels,
      parse: (src) => parseProgram(src, { grammarSource: 'shadow.dl' }),
    })
    // Back-fill from the authoritative rows rather than replaying history:
    // `#edbRows` is what a `replaceProgram` replays from, and is exactly the
    // state the forward session is already in.
    for (const [relation, bucket] of this.#edbRows) {
      for (const row of bucket.values()) {
        try {
          session.update(relation, row, +1)
        } catch {
          // Not an EDB of this program — the same rows `replaceProgram` parks
          // for a future rebuild. Skip rather than poison the rest.
        }
      }
    }
    session.advance()
    this.#backward = session
    return session
  }

  /** Drop the backward graph. It rebuilds itself from `#edbRows` on the next
   *  write, so this is how a program swap takes effect. */
  #closeBackward(): void {
    if (!this.#backward) return
    try {
      this.#backward.close()
    } catch {
      // already closed — ignore
    }
    this.#backward = null
  }

  /** True if edits to this view were opted into. */
  canWrite(relation: string): boolean {
    return this.#writable.has(relation)
  }

  /** Column indices of a view an edit can be written through.
   *
   *  The static answer, for deciding which inputs to render as editable before
   *  there is a row in hand. Whether a *particular* edit succeeds is a
   *  different question that the `Resolution` answers exactly — a column listed
   *  here can still come back `ambiguous` or `unsatisfied` for a given row.
   *
   *  Cached per program: it depends only on the rules, not on the facts. */
  writableColumns(relation: string): readonly number[] {
    if (!this.#writable.has(relation)) return []
    if (this.#writableColumns === null) {
      this.#writableColumns = compileShadow(this.#program, {
        views: [...this.#writable],
        put: this.#put,
        channels: this.#channels,
      }).writableColumns
    }
    return this.#writableColumns[relation] ?? []
  }

  /** Rewrite one derived row. */
  updateRow(relation: string, row: Row, newRow: Row, options: WriteOptions = {}): Resolution {
    return this.#write(relation, { rel: relation, row, newRow }, options)
  }

  /** Remove a derived row, by removing what supports it. */
  removeRow(relation: string, row: Row, options: WriteOptions = {}): Resolution {
    return this.#write(relation, { rel: relation, row }, options)
  }

  /** Add a derived row, by adding what would derive it. */
  insertRow(relation: string, row: Row, options: WriteOptions = {}): Resolution {
    return this.#write(relation, { rel: relation, row, insert: true }, options)
  }

  #write(relation: string, request: BackwardRequest, options: WriteOptions): Resolution {
    if (!this.#writable.has(relation)) {
      return {
        status: 'refused',
        reason:
          `"${relation}" is not writable — pass it in the store's \`writable\` option to ` +
          'opt in. Shadow rules are only compiled for views that ask for them.',
      }
    }
    // Any queued EDB writes have to reach the backward graph before it is
    // asked, or the request resolves against a state the store has already
    // moved on from.
    this.#flushNow()
    const session = this.#backwardSession()
    /* c8 ignore next */
    if (!session) return { status: 'refused', reason: `"${relation}" is not writable` }

    const resolution = session.resolve(request, {
      requireUnambiguous: options.requireUnambiguous,
      minimize: options.minimize,
      // Applied below through the ordinary path, which mirrors back into this
      // very session — committing here as well would count them twice.
      commit: false,
    })
    if (resolution.status !== 'ok' || options.dryRun) return resolution

    // Apply through the ordinary update path, so the EDB mirror, the live
    // queries and the batching all behave exactly as they do for a direct
    // collection write.
    for (const change of resolution.changes) {
      if (change.kind === 'del') this.update(change.rel, change.row, -1)
      else if (change.kind === 'ins') this.update(change.rel, change.row, +1)
      else {
        this.update(change.rel, change.row, -1)
        this.update(change.rel, change.newRow!, +1)
      }
    }
    return resolution
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
    this.#backward?.advance()
    // Apply the diffs gathered by the sink, then notify listeners for
    // each relation whose row set actually changed.
    const changed = new Set<string>()
    for (const rel of this.#touchedThisTick) {
      const state = this.#getState(rel)
      let mutated = false
      for (const [key, [row, delta]] of state.pending) {
        // Fold this tick's diff into the running multiplicity, then read
        // presence off the total. Reading it off `delta` alone would drop any
        // row whose derivations were shuffled rather than removed — see the
        // note on `counts`.
        const count = (state.counts.get(key) ?? 0) + delta
        if (count === 0) state.counts.delete(key)
        else state.counts.set(key, count)
        const had = state.rows.has(key)
        if (count <= 0) {
          if (had) {
            state.rows.delete(key)
            mutated = true
          }
        } else if (!had) {
          state.rows.set(key, row)
          mutated = true
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

/** The result of running a one-off program over the store's facts. */
export interface AdHocResult {
  /** Rows per relation the query derived. Source relations are excluded — they
   *  are the input, and echoing them back would bury the answer. */
  rows: ReadonlyMap<string, ReadonlyArray<Row>>
  /** A parse or evaluation failure, as something to show rather than throw. A
   *  query console's normal state is half-written. */
  error: string | null
}

const EMPTY_RESULT: AdHocResult = { rows: new Map(), error: null }

/**
 * React hook: run a program the store has never seen, over the facts it
 * currently holds.
 *
 * `useLiveQuery` reads a relation the program already declares. This is for the
 * other case — a query somebody just typed — where there is no relation to
 * subscribe to because the rule did not exist when the graph was built.
 *
 * Splicing it into the live program is the wrong trade: that rebuilds the whole
 * graph and makes a scratch query everyone else's problem. So this evaluates it
 * in a throwaway, which is a batch run and priced like one.
 *
 * What it does *not* do is re-derive the facts. A consumer left to itself
 * reaches for whatever it parsed the project from, and then the query can only
 * see what came from that source — flow-page's console could query its CSS and
 * not the canvas, because canvas facts are put into the store directly and were
 * never in a file. Reading the store's own relations is both cheaper and the
 * only way to see everything it knows.
 *
 * Re-runs when the source changes, when the program is swapped, and when any
 * source relation does. That last one is the expensive one: a batch evaluation
 * per edit. Fine for a console someone is looking at, wrong for anything on a
 * hot path — which is what `writable` views and `useLiveQuery` are for.
 */
export function useAdHocQuery(store: Store, source: string): AdHocResult {
  const program = useProgram(store)
  // One subscription covering every source relation: any of them changing
  // changes the answer, and a query console is not worth finer granularity.
  const version = useSyncExternalStore(
    (cb) => {
      const offs = program.edbs.map((d) => store.subscribe(d.name, cb))
      return () => {
        for (const off of offs) off()
      }
    },
    () => store.edbVersion(),
    () => store.edbVersion(),
  )

  return useMemo(() => {
    if (!source.trim()) return EMPTY_RESULT
    return store.runAdHoc(source)
    // `version` is the dependency that matters — it moves whenever the facts
    // do — and the linter cannot see that, hence naming it here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, source, program, version])
}

/** A live view you can write through. */
export interface WritableQuery<T extends Row> {
  rows: ReadonlyArray<T>
  /** Whether the store opted this view in. When false, the operations below
   *  all return `refused` — so a UI can grey out the controls instead of
   *  finding out on click. */
  canWrite: boolean
  /** Column indices an edit can be written through. Use it to decide which
   *  cells to render as editable; use the returned `Resolution` to decide
   *  whether a particular edit actually worked. */
  writableColumns: readonly number[]
  /** Convenience for the common per-cell check. */
  canWriteColumn(column: number): boolean
  update(row: T, next: T, options?: WriteOptions): Resolution
  remove(row: T, options?: WriteOptions): Resolution
  insert(row: T, options?: WriteOptions): Resolution
}

/**
 * React hook: an IDB relation's live rows, plus the operations that write back
 * through it. The operations return a `Resolution` rather than throwing, since
 * "this edit is ambiguous" and "that row is stale" are things a UI should show
 * rather than crash on.
 */
export function useWritableQuery<T extends Row>(
  store: Store,
  relation: string,
): WritableQuery<T> {
  const rows = useLiveQuery<T>(store, relation)
  const writableColumns = store.writableColumns(relation)
  return {
    rows,
    canWrite: store.canWrite(relation),
    writableColumns,
    canWriteColumn: (column) => writableColumns.includes(column),
    update: (row, next, options) => store.updateRow(relation, row, next, options),
    remove: (row, options) => store.removeRow(relation, row, options),
    insert: (row, options) => store.insertRow(relation, row, options),
  }
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
