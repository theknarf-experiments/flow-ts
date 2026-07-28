// What gets compiled, and what that costs.
//
// The other two pages are about what the backward direction *means*. This one
// is about who decides that it exists at all: the schema (`.put none`), the
// host (`writable`, `channels`), and the difference between resolving each
// request from scratch and maintaining the answer.

import { useMemo, useState } from 'react'
import { useProgram, useWritableQuery } from '@flow-ts/react'
import type { ShadowChannel } from 'flow-ts'
import { compileShadow, openBackwardSession, resolveBackward } from 'flow-ts'
import { parseProgram } from '@flow-ts/parsing'
import { columnNames, reasonOf, store, useVault } from './shell.js'

/** `Load(path, count(text)) :- Open(path, text).`
 *
 *  The view that is read-only on purpose. Its inverse is not ambiguous — it is
 *  absent. No assignment of tasks is *the* meaning of setting a count to 3, so
 *  there is nothing for an annotation like `spread` to pick between.
 *
 *  `.put none` is how the schema says that, and it is a different statement
 *  from leaving the view out of the host's `writable` list. That list is this
 *  application declining to offer the edit, and it travels with the
 *  application; `Load` is in it. `.put none` travels with the program, so every
 *  consumer gets the same answer — and the refusal names the annotation instead
 *  of reading like a rule someone forgot to write. */
function LoadTable() {
  const view = useWritableQuery<readonly [string, number]>(store, 'Load')
  const [refusal, setRefusal] = useState<string | null>(null)
  const rows = useMemo(() => [...view.rows].sort((a, b) => a[0].localeCompare(b[0])), [view.rows])

  return (
    <section className="card">
      <h2>Load</h2>
      <p className="muted">
        <code>Load(path, count(text)) :- Open(path, text).</code> Opted in by this
        application — it is in the store's <code>writable</code> list like every other table
        here — and still not writable, because the program says so.{' '}
        <span data-testid="load-writable">
          editable: {view.writableColumns.map((i) => columnNames('Load')[i] ?? i).join(', ') || 'none'}
        </span>
      </p>
      <ul className="tasks" data-testid="load-list">
        {rows.map((row) => (
          <li key={row[0]} data-testid={`load-${row[0]}`}>
            <span data-testid={`load-count-${row[0]}`}>{row[1]}</span>
            <span className="muted">open in {row[0]}</span>
            <button
              type="button"
              data-testid={`load-try-${row[0]}`}
              onClick={() => setRefusal(reasonOf(view.update(row, [row[0], row[1] + 1], { dryRun: true })))}
            >
              try +1
            </button>
          </li>
        ))}
      </ul>
      {refusal && (
        <p className="muted" data-testid="load-refusal">
          {refusal}
        </p>
      )}
      <p className="muted">
        Remove <code>.put none</code> from the program and the refusal changes: the engine
        goes back to reporting what it could not work out — an aggregate whose inverse is a
        distribution policy — which is a different answer from "there isn't one".
      </p>
    </section>
  )
}

// -- what gets compiled -------------------------------------------------
//
// The claim the whole design rests on is that the backward direction is *more
// Datalog* — not a graph walk, not a bespoke interpreter, just rules the same
// engine maintains. That is easy to assert and better to show, so this panel
// prints them.
//
// It is also where the cost lives. A shadow rule replays its rule's body, which
// forces joins — and the indexes behind them — that the forward program never
// needed. Every view you opt into and every channel you leave on is rules on
// this list, maintained continuously, on behalf of an edit that may never
// happen. Turning a view off and watching the list shrink is the argument for
// opt-in in one gesture.

const CHANNELS: ReadonlyArray<{ id: ShadowChannel; label: string; why: string }> = [
  { id: 'del', label: 'del', why: 'fans out over every rule of a head, so it is the dearest' },
  { id: 'ins', label: 'ins', why: 'picks one rule and fans out over its body' },
  { id: 'upd', label: 'upd', why: 'carries the old row and the new one, so its arity is doubled' },
]

const VIEWS = ['Task', 'Agenda', 'Outline', 'Effort', 'Line', 'Load', 'Minutes', 'Missing']

export function CompiledPanel() {
  const [views, setViews] = useState<string[]>(['Agenda'])
  const [channels, setChannels] = useState<ShadowChannel[]>(['upd'])
  // Subscribe to program swaps directly. The shell re-renders on one, but this
  // panel's whole job is to show what the *current* rules compile to, and
  // depending on a parent's render to notice that is the kind of coupling that
  // works until someone memoises the route.
  const live = useProgram(store)

  const shadow = useMemo(() => {
    // Compile against the *live* program, so editing the rules on any page
    // changes what shows up here.
    const compiled = compileShadow(live, {
      views,
      channels: channels.length > 0 ? channels : [],
    })
    const at = compiled.source.indexOf('.rule')
    const emitted = compiled.source
      .slice(at + '.rule'.length)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    // Only the generated ones — the original rules are in the program panel.
    const forward = new Set(live.rules.map((r) => r.toString()))
    return { rules: emitted.filter((l) => !forward.has(l)), seeds: compiled.seeds }
  }, [views, channels, live])

  const toggle = <T,>(list: T[], set: (next: T[]) => void, item: T) =>
    set(list.includes(item) ? list.filter((x) => x !== item) : [...list, item])

  return (
    <section className="card">
      <h2>What gets compiled</h2>
      <p className="muted">
        The backward direction is more Datalog — the same engine maintains it, and these are
        the rules. Which is also where the cost is: each one replays a body, forcing joins
        the forward program never needed, continuously, for an edit that may never come.
        That is the whole argument for opting in rather than out.
      </p>

      <div className="opt-in-controls">
        <fieldset data-testid="compiled-views">
          <legend>views</legend>
          {VIEWS.map((v) => (
            <label key={v}>
              <input
                type="checkbox"
                data-testid={`compiled-view-${v}`}
                checked={views.includes(v)}
                onChange={() => toggle(views, setViews, v)}
              />
              {v}
            </label>
          ))}
        </fieldset>
        <fieldset data-testid="compiled-channels">
          <legend>channels</legend>
          {CHANNELS.map((c) => (
            <label key={c.id} title={c.why}>
              <input
                type="checkbox"
                data-testid={`compiled-channel-${c.id}`}
                checked={channels.includes(c.id)}
                onChange={() => toggle(channels, setChannels, c.id)}
              />
              {c.label}
            </label>
          ))}
        </fieldset>
      </div>

      <p className="muted" data-testid="compiled-count">
        {shadow.rules.length} shadow rules for {views.length} view
        {views.length === 1 ? '' : 's'} × {channels.length} channel
        {channels.length === 1 ? '' : 's'}
      </p>
      <pre className="program-editor" data-testid="compiled-source">
        {shadow.rules.join('\n') || 'nothing — with no view or no channel there is nothing to compile'}
      </pre>
    </section>
  )
}

// -- resolving vs maintaining -------------------------------------------
//
// `resolveBackward` compiles, runs and throws the graph away per request. The
// store uses it deliberately: it costs nothing per read, scopes itself to the
// one view being edited, and works on recursive programs. For a UI that reads
// constantly and writes rarely, that is the right way round.
//
// It is also not the point. Compiling the backward direction into Datalog buys
// something a graph walk cannot: the shadow relations are ordinary IDBs, so
// they can be *maintained*. `openBackwardSession` holds one graph over
// `program + shadow(program)` and a request costs the delta rather than a
// re-run — with the same state answering what the view says, what could have
// produced a row, and whether applying the answer worked.
//
// The measure here is `emissions()` — sink callbacks, i.e. work actually done —
// rather than a wall clock, because it is the thing that doesn't change when
// the machine is busy.

interface Burst {
  edits: number
  oneShot: number
  session: number
  agree: boolean
}

export function SessionPanel() {
  const { facts } = useVault()
  const [burst, setBurst] = useState<Burst | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = () => {
    setError(null)
    const parse = (src: string) => parseProgram(src, { grammarSource: 'shadow.dl' })
    const edb: Record<string, (string | number)[][]> = {
      MdTask: facts.MdTask.map((r) => [...r]),
      MdHeading: facts.MdHeading.map((r) => [...r]),
      MdEstimate: facts.MdEstimate.map((r) => [...r]),
      MdTag: facts.MdTag.map((r) => [...r]),
      Vocab: [...store.snapshot('Vocab')].map((r) => [...r]),
    }
    // Rename every open task, one edit at a time — the shape a UI actually
    // produces, and the shape that rewards a warm graph.
    const requests = store
      .snapshot('Open')
      .map((row, i) => ({ rel: 'Open', row: [...row], newRow: [row[0]!, `renamed ${i}`] }))
    if (requests.length === 0) {
      setError('no open tasks to edit')
      return
    }

    try {
      let oneShot = 0
      const cold: string[] = []
      for (const req of requests) {
        const r = resolveBackward(store.program, edb, req, { parse, views: ['Open'] })
        oneShot++
        cold.push(r.status === 'ok' ? JSON.stringify(r.changes) : r.status)
      }

      // One graph, held open across the whole burst. Each request seeds, reads
      // and un-seeds, so the session comes back to exactly where it was.
      const session = openBackwardSession(store.program, { parse, views: ['Open'] })
      for (const [rel, rows] of Object.entries(edb)) {
        for (const row of rows) session.update(rel, row, +1)
      }
      session.advance()
      const before = session.emissions()
      const warm: string[] = []
      for (const req of requests) {
        const changes = session.propose(req)
        warm.push(changes.length > 0 ? JSON.stringify(changes) : 'none')
      }
      const emitted = session.emissions() - before
      session.close()

      setBurst({
        edits: requests.length,
        oneShot,
        session: emitted,
        // The interesting assertion is not that it is faster but that it is the
        // same answer. A cheaper wrong answer would be no use.
        agree: warm.every((w, i) => cold[i]!.includes(w) || w === 'none'),
      })
    } catch (e) {
      // A recursive program is refused outright, and the message says why.
      setError(e instanceof Error ? e.message : String(e))
      setBurst(null)
    }
  }

  return (
    <section className="card">
      <h2>Resolving vs maintaining</h2>
      <p className="muted">
        Every edit on the other pages calls <code>resolveBackward</code>, which compiles,
        runs and throws the graph away. That is the right trade for a UI: nothing per read,
        scoped to the one view being edited, and it works on recursive programs.{' '}
        <code>openBackwardSession</code> is the other end — one graph over{' '}
        <code>program + shadow(program)</code>, held open, where a request costs the delta
        instead of a re-run. The count below is emissions, meaning work done, rather than a
        clock.
      </p>
      <button type="button" data-testid="session-run" onClick={run}>
        rename every open task, both ways
      </button>
      {error && (
        <p className="muted" data-testid="session-error">
          {error}
        </p>
      )}
      {burst && (
        <ul className="tasks" data-testid="session-result">
          <li>
            <span data-testid="session-edits">{burst.edits}</span>
            <span className="muted">edits, each one a full request</span>
          </li>
          <li>
            <span data-testid="session-oneshot">{burst.oneShot}</span>
            <span className="muted">graphs built and thrown away by resolveBackward</span>
          </li>
          <li>
            <span data-testid="session-emissions">{burst.session}</span>
            <span className="muted">emissions through one session, which was built once</span>
          </li>
          <li>
            <span data-testid="session-agree">{burst.agree ? 'same answer' : 'DIVERGED'}</span>
            <span className="muted">
              the point is not that it is cheaper but that it agrees
            </span>
          </li>
        </ul>
      )}
      <p className="muted">
        A session refuses a recursive program outright, and says so rather than being subtly
        wrong: incremental retraction is unsound when derivations can be cyclic, and this
        session retracts constantly — every proposal un-seeds itself.{' '}
        <code>resolveBackward</code> recomputes per request and is unaffected, which is why
        it is what the store uses.
      </p>
    </section>
  )
}

/** `/vault/opt-in` — who decides the backward direction exists, and what it
 *  costs when it does. */
export function OptInPage() {
  return (
    <>
      <LoadTable />
      <CompiledPanel />
      <SessionPanel />
    </>
  )
}
