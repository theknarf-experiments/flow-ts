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

import { useMemo, useState } from 'react'
import { parseProgram } from '@flow-ts/parsing'
import { Store, useLiveQuery, useProgram } from './lib/store.js'
import { program as initialProgram, SOURCE } from './program.js'
import { RelationTable } from './components/RelationTable.js'

// One store per app. Seeded outside the React tree so HMR / strict-mode
// double-mounts don't try to spin up a second graph.
const store = new Store(initialProgram)
const persons = store.collection<readonly [number, string]>('Person')
const me = store.collection<readonly [number]>('Me')
const friends = store.collection<readonly [number, number]>('Friend')
const weights = store.collection<readonly [number, number]>('Weight')

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
// Seed a weight (in kg, as a float column) for each person. Only the
// reachable ones surface in ReachableWeight — frank's row sits idle
// until you friend him in.
for (const [id, kg] of [
  [1, 62.5],
  [2, 78.4],
  [3, 55.1],
  [4, 91.2],
  [5, 67.8],
  [6, 70.0],
] as Array<[number, number]>) {
  weights.insert([id, kg])
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
  // Live-editable Datalog source. "Rebuild" parses the textarea, and if
  // the new program parses cleanly, swaps it into the running store —
  // existing EDB rows are captured and replayed against the new rules,
  // so the demo's seed graph survives a rule edit.
  const [draft, setDraft] = useState<string>(SOURCE.trim())
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'dirty' | 'rebuilt'>('idle')

  const onChange = (next: string) => {
    setDraft(next)
    setError(null)
    setStatus(next.trim() === SOURCE.trim() ? 'idle' : 'dirty')
  }

  const rebuild = () => {
    try {
      const newProgram = parseProgram(draft, { grammarSource: 'live.dl' })
      store.replaceProgram(newProgram)
      setError(null)
      setStatus('rebuilt')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('dirty')
    }
  }

  const reset = () => {
    setDraft(SOURCE.trim())
    setError(null)
    try {
      store.replaceProgram(parseProgram(SOURCE, { grammarSource: 'demo.dl' }))
      setStatus('rebuilt')
    } catch {
      // The bundled SOURCE is known-good — this branch is unreachable.
    }
  }

  return (
    <section className="program">
      <details open data-testid="program-panel">
        <summary>Datalog program</summary>
        <textarea
          className="program-editor"
          data-testid="program-source"
          value={draft}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          rows={Math.min(20, draft.split('\n').length + 1)}
        />
        <div className="program-actions">
          <button
            data-testid="program-rebuild"
            onClick={rebuild}
            disabled={status === 'idle'}
          >rebuild</button>
          <button
            data-testid="program-reset"
            onClick={reset}
            disabled={draft.trim() === SOURCE.trim()}
          >reset to seed</button>
          <span className="program-status" data-testid="program-status">
            {error
              ? <span className="program-error">{error}</span>
              : status === 'dirty'
                ? <span className="muted">unsaved changes — click rebuild to apply</span>
                : status === 'rebuilt'
                  ? <span className="muted">program rebuilt · EDB rows replayed</span>
                  : <span className="muted">edit the rules above, then rebuild — current EDB rows replay automatically.</span>}
          </span>
        </div>
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
  //
  // After a rule edit + rebuild, `useProgram` re-renders this section
  // with the new EDB / IDB list — so adding a `.decl` and clicking
  // rebuild surfaces a fresh table here automatically.
  const program = useProgram(store)
  const decls = useMemo(
    () => [
      ...program.edbs.map((d) => ({ decl: d, isEdb: true })),
      ...program.idbs.map((d) => ({ decl: d, isEdb: false })),
    ],
    [program],
  )
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
