// Two-replica MVR key-value store demo, with a toggle to flip between
// the no-causal-broadcast and causal-broadcast variants of the same
// Datalog program. The interesting demo is:
//
//   1. Take Replica B offline.
//   2. Write `color = red` at A, `color = blue` at B.
//   3. Bring B online — both replicas converge to *both* values on
//      the same key. MVR semantics: concurrent writes don't override,
//      they coexist as a set.
//
// Switching the variant calls `store.replaceProgram` on each replica;
// the `#edbRows` cache survives the swap so the Set / Pred log stays
// intact. The two stores share their EDB op-log via the same
// `SyncLink` we use for the text demo.

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Store, useLiveQuery, useProgram } from '@flow-ts/react'
import { RelationTable } from './components/RelationTable.js'
import { SyncLink, type ReplicaId } from './SyncLink.js'
import { MVR_SOURCES, parseMvr, type MvrVariant } from './mvrProgram.js'

type SetRow = readonly [number, number, string, string]
type PredRow = readonly [number, number, number, number]
type LeafByKeyRow = readonly [number, number, string]
type MvrStoreRow = readonly [string, string]

const SYNCED_RELATIONS = ['Set', 'Pred']

const initialProgram = parseMvr('no_cb')

const storeA = new Store(initialProgram)
const storeB = new Store(initialProgram)
const sync = new SyncLink(storeA, storeB, SYNCED_RELATIONS)

interface ReplicaBindings {
  id: ReplicaId
  repId: number
  store: Store
}

const REPLICAS: Record<ReplicaId, ReplicaBindings> = {
  a: { id: 'a', repId: 1, store: storeA },
  b: { id: 'b', repId: 2, store: storeB },
}

function useSyncState() {
  return useSyncExternalStore(
    (cb) => sync.subscribe(cb),
    () => sync.snapshot(),
    () => sync.snapshot(),
  )
}

export function MvrDemo(): JSX.Element {
  // Variant lives in React state so the toggle re-renders both panels.
  // On change, swap each replica's running program.
  const [variant, setVariant] = useState<MvrVariant>('no_cb')

  const onVariantChange = (next: MvrVariant) => {
    if (next === variant) return
    const newProgram = parseMvr(next)
    // replaceProgram preserves EDB rows; only the derived IDBs rebuild.
    storeA.replaceProgram(newProgram)
    storeB.replaceProgram(newProgram)
    setVariant(next)
  }

  return (
    <div className="app">
      <header>
        <h1>flow-ts • MVR key-value store demo</h1>
        <p>
          Two-replica multi-value register from Stewen §4.2.1. Every
          write to a key creates an immutable <code>Set</code> op and
          a <code>Pred</code> edge from each currently-known leaf for
          that key — so concurrent writes neither override each other.
          Take a replica offline, edit the same key on both sides,
          then reconnect: both values surface on both replicas.
        </p>
      </header>

      <VariantToggle variant={variant} onChange={onVariantChange} />
      <ProgramPanel variant={variant} />

      <section className="grid">
        <ReplicaPanel binding={REPLICAS.a} title="Replica A" />
        <ReplicaPanel binding={REPLICAS.b} title="Replica B" />
      </section>

      <SyncStatusPanel />

      <RelationInspector binding={REPLICAS.a} title="Replica A relations" />
    </div>
  )
}

// --- variant toggle --------------------------------------------------

function VariantToggle({
  variant,
  onChange,
}: {
  variant: MvrVariant
  onChange: (next: MvrVariant) => void
}): JSX.Element {
  return (
    <section className="variant-toggle" data-testid="variant-toggle">
      <span className="variant-toggle-label">Program variant:</span>
      <label>
        <input
          type="radio"
          name="mvr-variant"
          value="no_cb"
          checked={variant === 'no_cb'}
          onChange={() => onChange('no_cb')}
          data-testid="variant-no-cb"
        />
        <span>no causal broadcast</span>
      </label>
      <label>
        <input
          type="radio"
          name="mvr-variant"
          value="with_cb"
          checked={variant === 'with_cb'}
          onChange={() => onChange('with_cb')}
          data-testid="variant-with-cb"
        />
        <span>with causal broadcast</span>
      </label>
    </section>
  )
}

// --- program panel ---------------------------------------------------

function ProgramPanel({ variant }: { variant: MvrVariant }): JSX.Element {
  return (
    <section className="program">
      <details data-testid="program-panel">
        <summary>Datalog program (shared)</summary>
        <pre data-testid="program-source"><code>{MVR_SOURCES[variant].trim()}</code></pre>
      </details>
    </section>
  )
}

// --- replica panel ---------------------------------------------------

function ReplicaPanel({
  binding,
  title,
}: {
  binding: ReplicaBindings
  title: string
}): JSX.Element {
  const { id, repId, store } = binding

  const sets = useLiveQuery<SetRow>(store, 'Set')
  const preds = useLiveQuery<PredRow>(store, 'Pred')
  const leaves = useLiveQuery<LeafByKeyRow>(store, 'LeafByKey')
  const mvrStore = useLiveQuery<MvrStoreRow>(store, 'MvrStore')

  // Counter generator anchored to the current `max(ctr)` for local
  // ops. Re-seed whenever `Set` snapshots change so remote inserts
  // don't burn a future local counter.
  const [, forceRefresh] = useState(0)
  const ctrRef = useMemo(() => ({ current: 0 }), [])
  useEffect(() => {
    let maxLocal = 0
    for (const row of sets) {
      if (row[0] === repId && row[1] > maxLocal) maxLocal = row[1]
    }
    if (maxLocal > ctrRef.current) ctrRef.current = maxLocal
  }, [sets, repId, ctrRef])

  // Group MVR values per key — used for the per-key value cell display.
  const valuesPerKey = useMemo(() => {
    const out = new Map<string, string[]>()
    for (const [k, v] of mvrStore) {
      const arr = out.get(k) ?? []
      arr.push(v)
      out.set(k, arr)
    }
    for (const arr of out.values()) arr.sort()
    return out
  }, [mvrStore])

  // Set of all keys we've ever seen, sorted, so adding a new key
  // doesn't reshuffle the rows above it.
  const allKeys = useMemo(() => {
    const set = new Set<string>()
    for (const [, , k] of leaves) set.add(k)
    for (const [k] of mvrStore) set.add(k)
    return [...set].sort()
  }, [leaves, mvrStore])

  /** Write a value to a key: emit one Set + a Pred from every
   *  currently-known leaf for that key. */
  const setKey = (key: string, value: string) => {
    if (!key.trim() || !value) return
    const ctr = ++ctrRef.current
    const currentLeaves = leaves.filter((row) => row[2] === key)
    store.update('Set', [repId, ctr, key, value], +1)
    for (const [lr, lc] of currentLeaves) {
      store.update('Pred', [lr, lc, repId, ctr], +1)
    }
    forceRefresh((n) => n + 1)
  }

  return (
    <div className="card replica-panel" data-testid={`replica-${id}`}>
      <div className="card-header">
        <h2>{title}</h2>
        <ReplicaControls id={id} />
      </div>

      <KeyValueTable
        replicaId={id}
        keys={allKeys}
        valuesPerKey={valuesPerKey}
        onSet={setKey}
      />

      <ul className="stat-line">
        <li>
          <span data-testid={`stat-sets-${id}`}>{sets.length}</span> Set ops
        </li>
        <li>
          <span data-testid={`stat-preds-${id}`}>{preds.length}</span> Pred edges
        </li>
        <li>
          <span data-testid={`stat-mvr-${id}`}>{mvrStore.length}</span> live rows
        </li>
      </ul>
    </div>
  )
}

function KeyValueTable({
  replicaId,
  keys,
  valuesPerKey,
  onSet,
}: {
  replicaId: ReplicaId
  keys: string[]
  valuesPerKey: Map<string, string[]>
  onSet: (key: string, value: string) => void
}): JSX.Element {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')

  const submitExisting = (key: string) => {
    const value = drafts[key] ?? ''
    if (!value.trim()) return
    onSet(key, value.trim())
    setDrafts((d) => ({ ...d, [key]: '' }))
  }

  const submitNew = () => {
    const k = newKey.trim()
    const v = newValue.trim()
    if (!k || !v) return
    onSet(k, v)
    setNewKey('')
    setNewValue('')
  }

  return (
    <table className="mvr-table" data-testid={`mvr-table-${replicaId}`}>
      <thead>
        <tr>
          <th>key</th>
          <th>value(s)</th>
          <th>write</th>
        </tr>
      </thead>
      <tbody>
        {keys.map((key) => {
          const vals = valuesPerKey.get(key) ?? []
          const conflicted = vals.length > 1
          return (
            <tr key={key} data-testid={`mvr-row-${replicaId}-${key}`}>
              <td className="mvr-key">{key}</td>
              <td>
                {vals.length === 0 ? (
                  <span className="muted">(empty)</span>
                ) : (
                  <span
                    className={conflicted ? 'mvr-conflict' : ''}
                    data-testid={`mvr-value-${replicaId}-${key}`}
                  >
                    {vals.join(', ')}
                  </span>
                )}
              </td>
              <td>
                <input
                  type="text"
                  className="mvr-write-input"
                  value={drafts[key] ?? ''}
                  onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      submitExisting(key)
                    }
                  }}
                  placeholder="new value"
                  data-testid={`mvr-write-${replicaId}-${key}`}
                />
              </td>
            </tr>
          )
        })}
        <tr data-testid={`mvr-add-row-${replicaId}`}>
          <td>
            <input
              type="text"
              className="mvr-write-input"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="new key"
              data-testid={`mvr-new-key-${replicaId}`}
            />
          </td>
          <td>
            <input
              type="text"
              className="mvr-write-input"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  submitNew()
                }
              }}
              placeholder="value"
              data-testid={`mvr-new-value-${replicaId}`}
            />
          </td>
          <td>
            <button
              className="mvr-add-button"
              onClick={submitNew}
              data-testid={`mvr-add-submit-${replicaId}`}
            >add</button>
          </td>
        </tr>
      </tbody>
    </table>
  )
}

// --- shared sync controls (mirrors TextDemo) -------------------------

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
