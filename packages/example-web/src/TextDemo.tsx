// Two-replica RGA text CRDT demo with simulated network sync.
//
// Two independent `Store` instances run the same list-CRDT program;
// each editor only ever writes to its own store. A `SyncLink` sitting
// on top of both stores (using only the public Store API) watches for
// new EDB rows on either side and forwards them to the other after a
// configurable delay. Per-replica online flags gate both sending and
// receiving — toggle one offline and its ops queue locally until the
// link comes back, then drain in arrival order. Type into both
// editors with one offline and watch them converge once you flip the
// switch back.

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type RefObject,
} from 'react'
import { Store, useLiveQuery, useProgram } from '@flow-ts/react'
import { RelationTable } from './components/RelationTable.js'
import { SyncLink, type ReplicaId } from './SyncLink.js'
import { textProgram, TEXT_SOURCE } from './textProgram.js'

type InsertRow = readonly [number, number, number, number, string]
type RemoveRow = readonly [number, number]
type ListElemRow = readonly [number, number, string, number, number]

type ElemId = readonly [number, number]

const SENTINEL: ElemId = [0, 0]
const SYNCED_RELATIONS = ['Insert', 'Remove']

// One store per replica; both load the same program but maintain
// independent state.
const storeA = new Store(textProgram)
const storeB = new Store(textProgram)
const sync = new SyncLink(storeA, storeB, SYNCED_RELATIONS)

const insertsA = storeA.collection<InsertRow>('Insert')
const removesA = storeA.collection<RemoveRow>('Remove')
const insertsB = storeB.collection<InsertRow>('Insert')
const removesB = storeB.collection<RemoveRow>('Remove')

interface ReplicaBindings {
  id: ReplicaId
  /** Unique numeric replica id so the two sides can't collide on
   *  `(rep_id, ctr)` tuples. */
  repId: number
  store: Store
  inserts: typeof insertsA
  removes: typeof removesA
}

const REPLICAS: Record<ReplicaId, ReplicaBindings> = {
  a: { id: 'a', repId: 1, store: storeA, inserts: insertsA, removes: removesA },
  b: { id: 'b', repId: 2, store: storeB, inserts: insertsB, removes: removesB },
}

function indexByPrev(elems: ReadonlyArray<ListElemRow>): Map<string, ListElemRow> {
  const out = new Map<string, ListElemRow>()
  for (const e of elems) out.set(`${e[0]},${e[1]}`, e)
  return out
}

function renderText(elems: ReadonlyArray<ListElemRow>): {
  text: string
  tail: ElemId[]
} {
  const byPrev = indexByPrev(elems)
  let cur = byPrev.get(`${SENTINEL[0]},${SENTINEL[1]}`)
  let text = ''
  const tail: ElemId[] = []
  while (cur) {
    const [, , value, nextR, nextC] = cur
    text += value
    tail.push([nextR, nextC])
    cur = byPrev.get(`${nextR},${nextC}`)
  }
  return { text, tail }
}

function diff(prev: string, next: string): {
  removeStart: number
  removeEnd: number
  insertChars: string
} {
  let prefixLen = 0
  const minLen = Math.min(prev.length, next.length)
  while (prefixLen < minLen && prev[prefixLen] === next[prefixLen]) prefixLen++
  let suffixLen = 0
  while (
    suffixLen < prev.length - prefixLen &&
    suffixLen < next.length - prefixLen &&
    prev[prev.length - 1 - suffixLen] === next[next.length - 1 - suffixLen]
  ) {
    suffixLen++
  }
  return {
    removeStart: prefixLen,
    removeEnd: prev.length - suffixLen,
    insertChars: next.slice(prefixLen, next.length - suffixLen),
  }
}

function useSyncState() {
  return useSyncExternalStore(
    (cb) => sync.subscribe(cb),
    () => sync.snapshot(),
    () => sync.snapshot(),
  )
}

export function TextDemo(): JSX.Element {
  return (
    <div className="app">
      <header>
        <h1>flow-ts • two-replica text CRDT demo</h1>
        <p>
          Two independent <code>Store</code> instances running the same
          list-CRDT program. Each editor only writes to its own store.
          A sync layer on top forwards new <code>Insert</code> and{' '}
          <code>Remove</code> ops between them after a configurable
          delay. Toggle a replica offline to see ops queue locally;
          flip it back on to watch the two sides converge.
        </p>
      </header>

      <ProgramPanel />

      <section className="grid">
        <ReplicaPanel binding={REPLICAS.a} title="Replica A" />
        <ReplicaPanel binding={REPLICAS.b} title="Replica B" />
      </section>

      <SyncStatusPanel />

      <RelationInspector binding={REPLICAS.a} title="Replica A relations" />
    </div>
  )
}

// --- panels ----------------------------------------------------------

function ProgramPanel() {
  return (
    <section className="program">
      <details data-testid="program-panel">
        <summary>Datalog program (shared)</summary>
        <pre data-testid="program-source"><code>{TEXT_SOURCE.trim()}</code></pre>
        <p className="muted">
          Both replicas load the same program; they only differ in
          which replica id (<code>1</code> vs <code>2</code>) they
          stamp on locally-emitted ops.
        </p>
      </details>
    </section>
  )
}

function ReplicaPanel({
  binding,
  title,
}: {
  binding: ReplicaBindings
  title: string
}): JSX.Element {
  const { id, repId, store, inserts, removes } = binding

  const ctrRef = useRef<number>(0)
  const nextCtr = () => ++ctrRef.current

  const elems = useLiveQuery<ListElemRow>(store, 'ListElem')
  const allInserts = useLiveQuery<InsertRow>(store, 'Insert')
  const allRemoves = useLiveQuery<RemoveRow>(store, 'Remove')
  const text = useMemo(() => renderText(elems), [elems])

  // After remote inserts land in this store, refresh `ctrRef` so we
  // don't reuse a counter for a new local insert. `ctr` is monotonic
  // per replica, so it's fine to bump to the local max.
  useEffect(() => {
    let maxLocal = 0
    for (const row of allInserts) {
      if (row[0] === repId && row[1] > maxLocal) maxLocal = row[1]
    }
    if (maxLocal > ctrRef.current) ctrRef.current = maxLocal
  }, [allInserts, repId])

  const typedRef = useRef<string>('')
  const visibleTailRef = useRef<ElemId[]>([])
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const pendingCursorRef = useRef<number | null>(null)

  useEffect(() => {
    typedRef.current = text.text
    visibleTailRef.current = text.tail
  }, [text])

  useLayoutEffect(() => {
    const target = pendingCursorRef.current
    if (target === null) return
    pendingCursorRef.current = null
    const el = editorRef.current
    if (el) el.setSelectionRange(target, target)
  })

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value
    const prev = typedRef.current
    if (next === prev) return
    pendingCursorRef.current = e.target.selectionStart

    const { removeStart, removeEnd, insertChars } = diff(prev, next)
    const tail = visibleTailRef.current
    for (let i = removeStart; i < removeEnd; i++) {
      const rowId = tail[i]
      if (rowId) removes.insert([rowId[0], rowId[1]])
    }
    const newIds: ElemId[] = []
    let parent: ElemId = removeStart > 0 ? tail[removeStart - 1]! : SENTINEL
    for (const ch of insertChars) {
      const ctr = nextCtr()
      const id: ElemId = [repId, ctr]
      inserts.insert([repId, ctr, parent[0], parent[1], ch])
      newIds.push(id)
      parent = id
    }
    visibleTailRef.current = [
      ...tail.slice(0, removeStart),
      ...newIds,
      ...tail.slice(removeEnd),
    ]
    typedRef.current = next
  }

  return (
    <div className="card replica-panel" data-testid={`replica-${id}`}>
      <div className="card-header">
        <h2>{title}</h2>
        <ReplicaControls id={id} />
      </div>
      <textarea
        ref={editorRef}
        className="text-editor"
        data-testid={`text-editor-${id}`}
        value={text.text}
        onChange={onChange}
        spellCheck={false}
        rows={6}
        placeholder="type here…"
      />
      <ul className="stat-line">
        <li>
          <span data-testid={`stat-inserts-${id}`}>{allInserts.length}</span> inserts
        </li>
        <li>
          <span data-testid={`stat-removes-${id}`}>{allRemoves.length}</span> removes
        </li>
        <li>
          <span data-testid={`stat-visible-${id}`}>{elems.length}</span> visible
        </li>
      </ul>
    </div>
  )
}

function ReplicaControls({ id }: { id: ReplicaId }): JSX.Element {
  const state = useSyncState()
  return (
    <div className="replica-controls">
      <label className="replica-online">
        <input
          type="checkbox"
          checked={state.online[id]}
          onChange={(e) => sync.setOnline(id, e.target.checked)}
          data-testid={`online-${id}`}
        />
        <span>online</span>
      </label>
      <label className="replica-delay">
        <span>delay</span>
        <input
          type="range"
          min={0}
          max={2000}
          step={50}
          value={state.delay[id]}
          onChange={(e) => sync.setDelay(id, Number(e.target.value))}
          data-testid={`delay-${id}`}
        />
        <span className="replica-delay-value" data-testid={`delay-value-${id}`}>
          {state.delay[id]}ms
        </span>
      </label>
    </div>
  )
}

function SyncStatusPanel(): JSX.Element {
  const state = useSyncState()
  const partitioned = !state.online.a || !state.online.b
  return (
    <section className="sync-status" data-testid="sync-status">
      <h2>Network</h2>
      <ul className="stat-line">
        <li>
          A → B queued:{' '}
          <span data-testid="sync-queue-a-to-b">{state.queueAtoB}</span>
        </li>
        <li>
          B → A queued:{' '}
          <span data-testid="sync-queue-b-to-a">{state.queueBtoA}</span>
        </li>
        <li className={partitioned ? 'network-status-partitioned' : ''} data-testid="sync-link-status">
          {partitioned ? 'partitioned' : 'connected'}
        </li>
      </ul>
    </section>
  )
}

function RelationInspector({
  binding,
  title,
}: {
  binding: ReplicaBindings
  title: string
}): JSX.Element {
  const { store, id } = binding
  const program = useProgram(store)
  const decls = useMemo(
    () => [
      ...program.edbs.map((d) => ({ decl: d, isEdb: true })),
      ...program.idbs.map((d) => ({ decl: d, isEdb: false })),
    ],
    [program],
  )
  return (
    <section className="inspector" data-testid={`inspector-${id}`}>
      <h2>{title}</h2>
      <p className="muted">
        The same generic <code>&lt;RelationTable&gt;</code> applied to
        replica {id.toUpperCase()}'s store. Both replicas converge to
        the same row sets once their queues drain, even after offline
        editing.
      </p>
      <div className="tables">
        {decls.map(({ decl, isEdb }) => (
          <RelationTable
            key={decl.name}
            store={store}
            program={program}
            relation={decl.name}
            actions={
              isEdb
                ? (row) => (
                    <button
                      aria-label={`remove ${decl.name} ${row.join(' ')}`}
                      className="row-action"
                      onClick={() => store.update(decl.name, [...row], -1)}
                    >×</button>
                  )
                : undefined
            }
          />
        ))}
      </div>
    </section>
  )
}
