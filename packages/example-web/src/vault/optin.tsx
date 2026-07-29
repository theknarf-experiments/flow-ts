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

// -- cost the delta, not the database -----------------------------------
//
// This engine is incremental in both directions, and that is not two ideas —
// it is one idea applied twice. Shadow rules are ordinary IDBs, so a graph that
// holds them answers a backward request the same way it answers a forward
// query: by propagating a delta.
//
// The delta here is the *request*. A backward request is a single row seeded
// into a channel, read, and un-seeded — so on a warm graph it costs the seed's
// selectivity, and on a cold one it costs building the graph and loading every
// fact first. That is the whole difference, and it is asymptotic rather than
// constant: warm stays flat as the vault grows, cold does not.
//
// `resolveBackward` is the cold path by construction — it compiles, runs and
// throws the graph away per request. The store uses it, and this panel is the
// honest accounting of what that costs. Growing the vault is the point: one
// number stays still and the other doesn't.

const SIZES = [2, 10, 40] as const

interface Measured {
  notes: number
  facts: number
  edits: number
  cold: number
  warm: number
  build: number
  agree: boolean
}

/** A synthetic vault, so the cost can be watched against data size without
 *  making the reader type out forty notes. */
function syntheticVault(notes: number): Record<string, (string | number)[][]> {
  const MdTask: (string | number)[][] = []
  const MdHeading: (string | number)[][] = []
  const MdEstimate: (string | number)[][] = []
  const MdTag: (string | number)[][] = []
  for (let i = 0; i < notes; i++) {
    const path = `n${i}.md`
    MdHeading.push([path, 1, 1, `Note ${i}`], [path, 3, 2, 'Week'])
    MdTag.push([path, 'urgent'])
    for (let j = 0; j < 5; j++) {
      MdTask.push([path, 4 + j, 'open', `task ${i}-${j}`])
      MdEstimate.push([path, 4 + j, j + 1])
    }
  }
  return { MdTask, MdHeading, MdEstimate, MdTag, Vocab: [['urgent'], ['errand'], ['waiting']] }
}

export function SessionPanel() {
  const live = useProgram(store)
  const [rows, setRows] = useState<Measured[]>([])
  const [error, setError] = useState<string | null>(null)

  const run = () => {
    setError(null)
    const parse = (src: string) => parseProgram(src, { grammarSource: 'shadow.dl' })
    const opts = { parse, views: ['Open'] }
    const out: Measured[] = []

    try {
      for (const notes of SIZES) {
        const facts = syntheticVault(notes)
        const load = (s: ReturnType<typeof openBackwardSession>) => {
          for (const [rel, rs] of Object.entries(facts)) for (const r of rs) s.update(rel, r, +1)
          s.advance()
        }
        // The same eight edits at every size, so the only thing changing is how
        // much data each one has to be found in.
        const requests = facts.MdTask!.slice(0, 8).map((r, i) => ({
          rel: 'Open',
          row: [r[0]!, r[3]!],
          newRow: [r[0]!, `renamed ${i}`],
        }))

        // Cold: a graph per request, built and thrown away — what
        // `resolveBackward` does, measured in the same unit as the warm path so
        // the two numbers can be compared at all.
        let cold = 0
        const coldAnswers: string[] = []
        for (const req of requests) {
          const s = openBackwardSession(live, opts)
          load(s)
          coldAnswers.push(JSON.stringify(s.propose(req)))
          cold += s.emissions()
          s.close()
        }

        // Warm: one graph, held open across all of them.
        const s = openBackwardSession(live, opts)
        load(s)
        const build = s.emissions()
        const warmAnswers = requests.map((req) => JSON.stringify(s.propose(req)))
        const warm = s.emissions() - build
        s.close()

        out.push({
          notes,
          facts: Object.values(facts).reduce((a, r) => a + r.length, 0),
          edits: requests.length,
          cold,
          warm,
          build,
          // The point is not that it is cheaper but that it is the same answer.
          agree: warmAnswers.every((w, i) => w === coldAnswers[i]),
        })
      }
      setRows(out)
    } catch (e) {
      // A recursive program is refused outright rather than answered wrongly.
      setError(e instanceof Error ? e.message : String(e))
      setRows([])
    }
  }

  return (
    <section className="card">
      <h2>Cost the delta, not the database</h2>
      <p className="muted">
        The engine is incremental in both directions, and that is one idea applied twice:
        shadow rules are ordinary IDBs, so a graph holding them answers a backward request by
        propagating a delta. The delta <em>is</em> the request — one row seeded into a
        channel, read, and un-seeded — so on a warm graph it costs the seed, and on a cold
        one it costs loading the whole vault first.
      </p>
      <p className="muted">
        Below: the same eight edits at three vault sizes, counted in emissions, which is work
        done rather than a clock. <code>resolveBackward</code> — what every edit on the other
        pages uses — is the cold column.
      </p>
      <button type="button" data-testid="session-run" onClick={run}>
        measure both ways
      </button>
      {error && (
        <p className="muted" data-testid="session-error">
          {error}
        </p>
      )}
      {rows.length > 0 && (
        <table className="agenda" data-testid="session-result">
          <thead>
            <tr>
              <th>vault</th>
              <th>facts</th>
              <th>cold</th>
              <th>warm</th>
              <th>build once</th>
              <th>agree</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.notes} data-testid={`session-row-${r.notes}`}>
                <td>{r.notes} notes</td>
                <td>{r.facts}</td>
                <td data-testid={`session-cold-${r.notes}`}>{r.cold}</td>
                <td data-testid={`session-warm-${r.notes}`}>{r.warm}</td>
                <td>{r.build}</td>
                <td data-testid={`session-agree-${r.notes}`}>{r.agree ? 'same' : 'DIVERGED'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted">
        The warm column does not move. That is the whole claim — a request costs the delta,
        so it is flat in the size of the vault, while the cold column grows with it. The
        standing cost is the other side: carrying shadow rules makes loading the graph about
        1.8× dearer and an incremental step about 3× dearer, on a base of a few microseconds
        and flat in data size (<code>pnpm bench</code>). A constant factor on the cheap thing,
        buying an asymptotic one on the dear thing.
      </p>
      <p className="muted">
        A session used to refuse recursive programs outright — retraction through a
        recursive stratum did not fully propagate, and a session cannot live with that
        since it retracts constantly: every proposal un-seeds itself, every speculation
        rolls back. That is fixed, so the choice between the two is now purely about
        where you want to pay. The cold path costs nothing to hold open and everything
        per request; the warm one is the other way round.
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
