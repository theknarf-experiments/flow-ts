// Demo: a tiny reachability graph editor. One shared `Store` powers
// four independent React components, each with its own `useLiveQuery`
// hook. Updates in one component (add a node, toggle the source,
// retract an edge) ripple incrementally to the others through the
// underlying flow-ts session.

import { useMemo, useState, type FormEvent } from 'react'
import type { Row } from '@flow-ts/reading'
import { Collection, Store, useLiveQuery } from './lib/store.js'
import { program } from './program.js'

// One store per app. Seeded outside the React tree so HMR / strict-mode
// double-mounts don't try to spin up a second graph.
const store = new Store(program)
const nodes = store.collection<readonly [number]>('Node')
const source = store.collection<readonly [number]>('Source')
const edges = store.collection<readonly [number, number]>('Edge')

// Seed a small graph so the page has something interesting on first load.
//   1 → 2 → 3 → 4
//   2 → 5
// Source = {1}, so 1, 2, 3, 4, 5 should all be reachable.
for (const id of [1, 2, 3, 4, 5, 6, 7]) nodes.insert([id])
source.insert([1])
for (const [a, b] of [[1, 2], [2, 3], [3, 4], [2, 5]] as Array<[number, number]>) {
  edges.insert([a, b])
}
// Node 6 and 7 exist but aren't connected — they should NOT appear in Reach.

export function App() {
  return (
    <div className="app">
      <header>
        <h1>flow-ts • reachability demo</h1>
        <p>
          One Datalog program. Four React components, four independent live
          queries. Edit the graph, watch the derived state update incrementally.
        </p>
      </header>

      <section className="grid">
        <StatsPanel />
        <EditorPanel />
        <NodesPanel />
        <ReachablePanel />
      </section>
    </div>
  )
}

// --- live-query consumers -------------------------------------------

function StatsPanel() {
  // Subscribes to all three relations. Re-renders only when one of
  // their snapshots changes (useSyncExternalStore guarantees that).
  const allNodes = useLiveQuery<readonly [number]>(store, 'Node')
  const allEdges = useLiveQuery<readonly [number, number]>(store, 'Edge')
  const reachable = useLiveQuery<readonly [number]>(store, 'Reach')
  return (
    <div className="card stats">
      <h2>Stats</h2>
      <dl>
        <dt>Nodes</dt><dd>{allNodes.length}</dd>
        <dt>Edges</dt><dd>{allEdges.length}</dd>
        <dt>Reachable</dt><dd>{reachable.length}</dd>
      </dl>
    </div>
  )
}

function NodesPanel() {
  // Renders every node, highlighting the ones reachable from the source.
  const allNodes = useLiveQuery<readonly [number]>(store, 'Node')
  const reachable = useLiveQuery<readonly [number]>(store, 'Reach')
  const reachSet = useMemo(
    () => new Set(reachable.map((r) => r[0])),
    [reachable],
  )
  const sorted = useMemo(
    () => [...allNodes].sort((a, b) => a[0] - b[0]),
    [allNodes],
  )
  return (
    <div className="card">
      <h2>All nodes</h2>
      <ul className="nodes">
        {sorted.map(([id]) => (
          <li key={id} className={reachSet.has(id) ? 'reachable' : ''}>
            {id} {reachSet.has(id) ? '· reachable' : ''}
            <button onClick={() => nodes.delete([id])}>×</button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ReachablePanel() {
  // The pure derived view: only what's currently reachable.
  const reachable = useLiveQuery<readonly [number]>(store, 'Reach')
  const sorted = useMemo(
    () => [...reachable].sort((a, b) => a[0] - b[0]),
    [reachable],
  )
  return (
    <div className="card">
      <h2>Reachable from source</h2>
      {sorted.length === 0 ? (
        <p className="muted">(none — pick a source below)</p>
      ) : (
        <ul className="reachable">
          {sorted.map(([id]) => <li key={id}>{id}</li>)}
        </ul>
      )}
    </div>
  )
}

function EditorPanel() {
  return (
    <div className="card">
      <h2>Edit graph</h2>
      <AddNode />
      <SetSource />
      <AddEdge />
      <EdgeList />
    </div>
  )
}

// --- forms ----------------------------------------------------------

function AddNode() {
  const [value, setValue] = useState('')
  return (
    <Form
      label="Add node"
      onSubmit={() => {
        const n = parseTuple(value, 1)
        if (n) {
          nodes.insert(n as readonly [number])
          setValue('')
        }
      }}
    >
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="42"
      />
    </Form>
  )
}

function SetSource() {
  const current = useLiveQuery<readonly [number]>(store, 'Source')
  const [value, setValue] = useState('')
  return (
    <div className="row">
      <label>
        Source:{' '}
        <span className="src">
          {current.length === 0 ? '(none)' : current.map((r) => r[0]).join(', ')}
        </span>
      </label>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="1"
        style={{ width: '4em' }}
      />
      <button
        onClick={() => {
          const n = parseTuple(value, 1)
          if (!n) return
          // Replace: retract whatever's currently in Source, then insert.
          for (const [old] of current) source.delete([old])
          source.insert(n as readonly [number])
          setValue('')
        }}
      >
        set
      </button>
      <button
        onClick={() => {
          for (const [old] of current) source.delete([old])
        }}
        disabled={current.length === 0}
      >
        clear
      </button>
    </div>
  )
}

function AddEdge() {
  const [src, setSrc] = useState('')
  const [dst, setDst] = useState('')
  return (
    <Form
      label="Add edge"
      onSubmit={() => {
        const a = Number(src), b = Number(dst)
        if (!Number.isFinite(a) || !Number.isFinite(b)) return
        edges.insert([a, b])
        setSrc('')
        setDst('')
      }}
    >
      <input value={src} onChange={(e) => setSrc(e.target.value)} placeholder="from" style={{ width: '4em' }} />
      <span>→</span>
      <input value={dst} onChange={(e) => setDst(e.target.value)} placeholder="to" style={{ width: '4em' }} />
    </Form>
  )
}

function EdgeList() {
  const allEdges = useLiveQuery<readonly [number, number]>(store, 'Edge')
  const sorted = useMemo(
    () => [...allEdges].sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    [allEdges],
  )
  return (
    <div className="edges">
      <h3>Edges</h3>
      {sorted.length === 0
        ? <p className="muted">(no edges)</p>
        : (
          <ul>
            {sorted.map(([a, b]) => (
              <li key={`${a}-${b}`}>
                {a} → {b}
                <button onClick={() => edges.delete([a, b])}>×</button>
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}

// --- shared bits ----------------------------------------------------

interface FormProps {
  label: string
  onSubmit: () => void
  children: React.ReactNode
}
function Form({ label, onSubmit, children }: FormProps) {
  return (
    <form
      className="row"
      onSubmit={(e: FormEvent) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      <label>{label}:</label>
      {children}
      <button type="submit">add</button>
    </form>
  )
}

function parseTuple(s: string, arity: number): Row | null {
  const parts = s.trim().split(/[,\s]+/).filter(Boolean).map(Number)
  if (parts.length !== arity || parts.some((n) => !Number.isFinite(n))) return null
  return parts
}
