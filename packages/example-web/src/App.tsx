// Demo: a tiny reachability graph editor. One shared `Store` powers
// four independent React components, each with its own `useLiveQuery`
// hook. Updates in one component (add a node, toggle the source,
// retract an edge) ripple incrementally to the others through the
// underlying flow-ts session.

import { useMemo, useState, type FormEvent } from 'react'
import type { Row } from '@flow-ts/reading'
import { Collection, Store, useLiveQuery } from './lib/store.js'
import { program, SOURCE } from './program.js'

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

      <ProgramPanel />

      <section className="grid">
        <StatsPanel />
        <EditorPanel />
        <NodesPanel />
        <ReachablePanel />
      </section>
    </div>
  )
}

// --- program source ------------------------------------------------

function ProgramPanel() {
  // Show the actual Datalog source so readers can map what they're
  // editing in the UI onto the rules driving the derivations. Wrapped
  // in <details> so the section can be collapsed once you've seen it.
  return (
    <section className="program">
      <details open data-testid="program-panel">
        <summary>Datalog program</summary>
        <pre data-testid="program-source"><code>{SOURCE.trim()}</code></pre>
        <p className="muted">
          Two EDBs (<code>Node</code>, <code>Source</code>, <code>Edge</code>) and
          one recursive IDB (<code>Reach</code>). The first rule seeds reach with the
          source; the second propagates reachability along edges.
        </p>
      </details>
    </section>
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
        <dt>Nodes</dt><dd data-testid="stat-nodes">{allNodes.length}</dd>
        <dt>Edges</dt><dd data-testid="stat-edges">{allEdges.length}</dd>
        <dt>Reachable</dt><dd data-testid="stat-reachable">{reachable.length}</dd>
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
      <ul className="nodes" data-testid="nodes-list">
        {sorted.map(([id]) => (
          <li
            key={id}
            data-testid={`node-${id}`}
            data-reachable={reachSet.has(id) ? 'true' : 'false'}
            className={reachSet.has(id) ? 'reachable' : ''}
          >
            {id} {reachSet.has(id) ? '· reachable' : ''}
            <button onClick={() => nodes.delete([id])} aria-label={`remove node ${id}`}>×</button>
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
        <p className="muted" data-testid="reachable-empty">(none — pick a source below)</p>
      ) : (
        <ul className="reachable" data-testid="reachable-list">
          {sorted.map(([id]) => <li key={id} data-testid={`reachable-${id}`}>{id}</li>)}
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
        aria-label="new node id"
        data-testid="add-node-input"
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
        <span className="src" data-testid="current-source">
          {current.length === 0 ? '(none)' : current.map((r) => r[0]).join(', ')}
        </span>
      </label>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="1"
        style={{ width: '4em' }}
        aria-label="new source id"
        data-testid="source-input"
      />
      <button
        data-testid="set-source"
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
        data-testid="clear-source"
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
      <input value={src} onChange={(e) => setSrc(e.target.value)} placeholder="from" style={{ width: '4em' }} aria-label="edge from" data-testid="edge-from-input" />
      <span>→</span>
      <input value={dst} onChange={(e) => setDst(e.target.value)} placeholder="to" style={{ width: '4em' }} aria-label="edge to" data-testid="edge-to-input" />
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
          <ul data-testid="edge-list">
            {sorted.map(([a, b]) => (
              <li key={`${a}-${b}`} data-testid={`edge-${a}-${b}`}>
                {a} → {b}
                <button onClick={() => edges.delete([a, b])} aria-label={`remove edge ${a} to ${b}`}>×</button>
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
