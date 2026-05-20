// Demo: a tiny reachability graph editor.
//
// One shared `Store` powers two specialised React panels (an all-nodes
// view that highlights reachability, and a reachable-only view) plus
// a generic `RelationInspector` that renders one `<RelationTable>` per
// declared relation. Edits in the inspector (add/delete rows) and in
// the bespoke panels (delete a node) ripple through the underlying
// flow-ts session and re-render the others incrementally.

import { useMemo } from 'react'
import { Store, useLiveQuery } from './lib/store.js'
import { program, SOURCE } from './program.js'
import { RelationTable } from './components/RelationTable.js'

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
          One Datalog program. Three React views, each with its own live query.
          Edit the graph in the inspector at the bottom, watch the derived
          state update incrementally up top.
        </p>
      </header>

      <ProgramPanel />

      <section className="grid">
        <NodesPanel />
        <ReachablePanel />
      </section>

      <RelationInspector />
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
          Three EDBs (<code>Node</code>, <code>Source</code>, <code>Edge</code>) and
          one recursive IDB (<code>Reach</code>). The first rule seeds reach with the
          source; the second propagates reachability along edges. EDB rows are
          inserted from the UI via <code>collection.insert()</code> — no fact
          files involved.
        </p>
      </details>
    </section>
  )
}

// --- live-query consumers -------------------------------------------

function NodesPanel() {
  // Renders every node, highlighting the ones reachable from the source.
  // Also surfaces the high-level counts at the top — same info as a
  // dedicated stats panel, just colocated with the most natural reader.
  const allNodes = useLiveQuery<readonly [number]>(store, 'Node')
  const allEdges = useLiveQuery<readonly [number, number]>(store, 'Edge')
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
      <div className="card-header">
        <h2>All nodes</h2>
        <ul className="stat-line" data-testid="stat-line">
          <li><span data-testid="stat-nodes">{allNodes.length}</span> nodes</li>
          <li><span data-testid="stat-edges">{allEdges.length}</span> edges</li>
          <li><span data-testid="stat-reachable">{reachable.length}</span> reachable</li>
        </ul>
      </div>
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
        <p className="muted" data-testid="reachable-empty">(none — add a row to Source in the inspector below)</p>
      ) : (
        <ul className="reachable" data-testid="reachable-list">
          {sorted.map(([id]) => <li key={id} data-testid={`reachable-${id}`}>{id}</li>)}
        </ul>
      )}
    </div>
  )
}

// --- generic relation inspector -------------------------------------

function RelationInspector() {
  // A single generic table component, instantiated once per relation,
  // drives its columns from the program's `.decl` and re-renders on
  // every diff via the same `useLiveQuery` hook as the bespoke panels
  // above. No per-relation glue. EDB tables grow an inline add-row;
  // IDB tables stay read-only.
  return (
    <section className="inspector">
      <h2>All relations</h2>
      <p className="muted">
        Schema-driven view powered by <code>@tanstack/react-table</code>. One
        generic <code>&lt;RelationTable&gt;</code> per declared relation —
        click a column header to sort, type into the bottom row to insert.
      </p>
      <div className="tables">
        <RelationTable
          store={store}
          program={program}
          relation="Node"
          actions={(row) => (
            <button
              aria-label={`remove node ${row[0]}`}
              className="row-action"
              onClick={() => nodes.delete([row[0]!] as readonly [number])}
            >×</button>
          )}
        />
        <RelationTable
          store={store}
          program={program}
          relation="Source"
          actions={(row) => (
            <button
              aria-label={`remove source ${row[0]}`}
              className="row-action"
              onClick={() => source.delete([row[0]!] as readonly [number])}
            >×</button>
          )}
        />
        <RelationTable
          store={store}
          program={program}
          relation="Edge"
          actions={(row) => (
            <button
              aria-label={`remove edge ${row[0]} to ${row[1]}`}
              className="row-action"
              onClick={() => edges.delete([row[0]!, row[1]!] as readonly [number, number])}
            >×</button>
          )}
        />
        <RelationTable store={store} program={program} relation="Reach" />
      </div>
    </section>
  )
}
