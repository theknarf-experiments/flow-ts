// Demo: a small friend graph that exercises both numeric and string
// columns end-to-end.
//
// One shared `Store` powers two bespoke React panels (a roster of all
// people that flags who's reachable from `Me`, and a name-only "I can
// reach" list) plus a generic `RelationInspector` that renders one
// `<RelationTable>` per declared relation. Edits in the inspector
// (add/delete rows) and in the bespoke panels (remove a person)
// ripple through the underlying flow-ts session and re-render the
// others incrementally.

import { useMemo } from 'react'
import { Store, useLiveQuery } from './lib/store.js'
import { program, SOURCE } from './program.js'
import { RelationTable } from './components/RelationTable.js'

// One store per app. Seeded outside the React tree so HMR / strict-mode
// double-mounts don't try to spin up a second graph.
const store = new Store(program)
const persons = store.collection<readonly [number, string]>('Person')
const me = store.collection<readonly [number]>('Me')
const friends = store.collection<readonly [number, number]>('Friend')

// Seed a small social graph.
//   1 alice ─▶ 2 bob ─▶ 3 carol ─▶ 4 dave
//   1 alice ─▶ 5 eve
// Me = {1}, so from alice the reachable set is {bob, carol, dave, eve}.
// 6 frank has no incoming friendship from alice's component.
for (const [id, name] of [
  [1, 'alice'],
  [2, 'bob'],
  [3, 'carol'],
  [4, 'dave'],
  [5, 'eve'],
  [6, 'frank'],
] as Array<[number, string]>) {
  persons.insert([id, name])
}
me.insert([1])
for (const [a, b] of [
  [1, 2],
  [2, 3],
  [3, 4],
  [1, 5],
] as Array<[number, number]>) {
  friends.insert([a, b])
}

export function App() {
  return (
    <div className="app">
      <header>
        <h1>flow-ts • friend-graph demo</h1>
        <p>
          One Datalog program with both numeric and string columns. Three
          React views, each with its own live query. Edit the graph in the
          inspector at the bottom, watch the derived state update
          incrementally up top.
        </p>
      </header>

      <ProgramPanel />

      <section className="grid">
        <PeoplePanel />
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
          Three EDBs (<code>Person</code>, <code>Me</code>,{' '}
          <code>Friend</code>) and two IDBs (<code>Reach</code> — recursive
          transitive closure of <code>Friend</code> — and{' '}
          <code>ICanReach</code>, which joins <code>Reach</code> back
          against <code>Person</code> to surface human-readable names).
          EDB rows are inserted from the UI via{' '}
          <code>collection.insert()</code> — no fact files involved.
        </p>
      </details>
    </section>
  )
}

// --- live-query consumers -------------------------------------------

function PeoplePanel() {
  // Roster of every person, badging the ones reachable from Me. Also
  // surfaces the high-level counts at the top — same info as a
  // dedicated stats panel, just colocated with the most natural reader.
  const allPersons = useLiveQuery<readonly [number, string]>(store, 'Person')
  const friendEdges = useLiveQuery<readonly [number, number]>(store, 'Friend')
  const reach = useLiveQuery<readonly [string]>(store, 'ICanReach')
  const meRows = useLiveQuery<readonly [number]>(store, 'Me')
  const reachSet = useMemo(
    () => new Set(reach.map((r) => r[0])),
    [reach],
  )
  const meName = useMemo(() => {
    const meId = meRows[0]?.[0]
    if (meId === undefined) return null
    return allPersons.find((p) => p[0] === meId)?.[1] ?? `#${meId}`
  }, [meRows, allPersons])
  const sorted = useMemo(
    () => [...allPersons].sort((a, b) => a[0] - b[0]),
    [allPersons],
  )
  return (
    <div className="card">
      <div className="card-header">
        <h2>People</h2>
        <ul className="stat-line" data-testid="stat-line">
          <li>me: <span data-testid="stat-me">{meName ?? '(none)'}</span></li>
          <li><span data-testid="stat-people">{allPersons.length}</span> people</li>
          <li><span data-testid="stat-friends">{friendEdges.length}</span> friendships</li>
          <li><span data-testid="stat-reachable">{reach.length}</span> reachable</li>
        </ul>
      </div>
      <ul className="nodes" data-testid="people-list">
        {sorted.map(([id, name]) => {
          const isReachable = reachSet.has(name)
          return (
            <li
              key={id}
              data-testid={`person-${id}`}
              data-name={name}
              data-reachable={isReachable ? 'true' : 'false'}
              className={isReachable ? 'reachable' : ''}
            >
              <span>
                <code>#{id}</code> {name}
                {meName === name && ' · me'}
                {isReachable && ' · reachable'}
              </span>
              <button
                onClick={() => persons.delete([id, name])}
                aria-label={`remove person ${name}`}
              >×</button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function ReachablePanel() {
  // The pure derived view: only the names currently reachable from Me.
  const reach = useLiveQuery<readonly [string]>(store, 'ICanReach')
  const sorted = useMemo(
    () => [...reach].map((r) => r[0]).sort((a, b) => a.localeCompare(b)),
    [reach],
  )
  return (
    <div className="card">
      <h2>I can reach</h2>
      {sorted.length === 0 ? (
        <p className="muted" data-testid="reachable-empty">(none — add a row to Me, or a friendship from me, in the inspector below)</p>
      ) : (
        <ul className="reachable" data-testid="reachable-list">
          {sorted.map((name) => (
            <li key={name} data-testid={`reachable-${name}`}>{name}</li>
          ))}
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
        String columns accept any text; numeric columns must parse as a
        number.
      </p>
      <div className="tables">
        <RelationTable
          store={store}
          program={program}
          relation="Person"
          actions={(row) => (
            <button
              aria-label={`remove person ${row[1]}`}
              className="row-action"
              onClick={() => persons.delete([row[0]!, row[1]!] as readonly [number, string])}
            >×</button>
          )}
        />
        <RelationTable
          store={store}
          program={program}
          relation="Me"
          actions={(row) => (
            <button
              aria-label={`remove me ${row[0]}`}
              className="row-action"
              onClick={() => me.delete([row[0]!] as readonly [number])}
            >×</button>
          )}
        />
        <RelationTable
          store={store}
          program={program}
          relation="Friend"
          actions={(row) => (
            <button
              aria-label={`remove friendship ${row[0]} to ${row[1]}`}
              className="row-action"
              onClick={() => friends.delete([row[0]!, row[1]!] as readonly [number, number])}
            >×</button>
          )}
        />
        <RelationTable store={store} program={program} relation="Reach" />
        <RelationTable store={store} program={program} relation="ICanReach" />
      </div>
    </section>
  )
}
