// Views whose inverse is not a copy.
//
// Everything on the Tracing page rewrites one fact, and the only question is
// which. These four are the cases where the shape of the backward direction is
// different in kind, and each one needs something the rule does not say:
//
//   Effort   one edit becomes many — a distribution, and `spread` picks who
//            absorbs what least change leaves over
//   Minutes  the head computes, so a write runs the computation backwards, and
//            the inverse only round-trips for some values
//   Tags     built on a negated atom, so removing a row *adds* a fact
//   Lines    two rules for one head, so an insert has to choose between them

import { useMemo, useState } from 'react'
import { useLiveQuery, useWritableQuery } from '@flow-ts/react'
import { VOCAB } from './program.js'
import type { Row } from './markdown.js'
import { type Write, reasonOf, store, useVault } from './shell.js'

/** `Effort(path, sum(hours)) :- MdEstimate(path, line, hours).`
 *
 *  The one view whose backward direction is a *distribution* rather than a
 *  copy. Every other edit here rewrites one fact; changing a total has to
 *  change several, and how to divide the change between them is not something
 *  the rule says. Least change settles most of it — everyone moves by the same
 *  amount — but hours are whole numbers, so a delta that doesn't divide leaves
 *  a remainder, and *who absorbs it* is a genuine choice. `.put spread(min)`
 *  makes it the earliest line in the note. */
function EffortTable({ write }: { write: Write }) {
  const view = useWritableQuery<readonly [string, number]>(store, 'Effort')
  const [editing, setEditing] = useState<{ path: string; value: string } | null>(null)
  const rows = useMemo(() => [...view.rows].sort((a, b) => a[0].localeCompare(b[0])), [view.rows])

  const commit = (row: readonly [string, number]) => {
    if (!editing || editing.path !== row[0]) return
    const next = Number(editing.value)
    setEditing(null)
    if (!Number.isFinite(next) || next === row[1]) return
    write(`set ${row[0]} to ${next}h`, () => view.update(row, [row[0], next], { dryRun: true }))
  }

  return (
    <section className="card">
      <h2>Effort</h2>
      <p className="muted">
        <code>Effort(path, sum(hours)) :- MdEstimate(path, line, hours).</code> Changing a
        total has to change several facts, and the rule does not say how to divide it.
        Least change spreads it evenly; hours are whole numbers, so a remainder goes to one
        task, and <code>.put spread(min)</code> is what names which — the earliest line.
      </p>
      <ul className="tasks" data-testid="effort-list">
        {rows.map((row) => (
          <li key={row[0]} data-testid={`effort-${row[0]}`}>
            <input
              type="number"
              aria-label={`total hours for ${row[0]}`}
              data-testid={`effort-input-${row[0]}`}
              value={editing?.path === row[0] ? editing.value : row[1]}
              readOnly={!view.canWriteColumn(1)}
              onChange={(e) => setEditing({ path: row[0], value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit(row)
              }}
              onBlur={() => commit(row)}
            />
            <span className="muted">hours across {row[0]}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** `Minutes(path, text, hours * 60) :- MdEstimate(path, line, hours), MdTask(...).`
 *
 *  A head that computes. The two directions need different things and it is
 *  worth keeping them apart: *deleting* a row never needed an inverse — it only
 *  asks which tuple produced the value, and replaying `h * 60` as a filter
 *  answers that. *Rewriting* the computed column is what needs one.
 *
 *  `* 60` has an inverse only up to truncation. 240 divides to 4 hours and
 *  round-trips; 150 divides to 2, which is 120, and does not. No static
 *  analysis distinguishes those two requests, because the difference is the
 *  value — so the protocol applies the change, re-runs the forward program,
 *  compares, and rolls back the one that missed. */
function MinutesTable({ write }: { write: Write }) {
  const view = useWritableQuery<readonly [string, string, number]>(store, 'Minutes')
  const [editing, setEditing] = useState<{ key: string; value: string } | null>(null)
  const rows = useMemo(
    () => [...view.rows].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])),
    [view.rows],
  )
  const keyOfRow = (row: readonly [string, string, number]) => `${row[0]}/${row[1]}`

  const commit = (row: readonly [string, string, number]) => {
    const k = keyOfRow(row)
    if (!editing || editing.key !== k) return
    const next = Number(editing.value)
    setEditing(null)
    if (!Number.isFinite(next) || next === row[2]) return
    write(`set "${row[1]}" to ${next}m`, () =>
      view.update(row, [row[0], row[1], next], { dryRun: true }),
    )
  }

  return (
    <section className="card">
      <h2>Minutes</h2>
      <p className="muted">
        <code>Minutes(p, t, h * 60) :- MdEstimate(p, l, h), MdTask(p, l, s, t).</code> The
        head computes, so a write has to run the computation backwards. Multiples of 60 go
        through. Anything else divides to an hour count that multiplies back to a different
        number — try 150 — and the protocol catches it by re-running rather than by knowing
        in advance.
      </p>
      <ul className="tasks" data-testid="minutes-list">
        {rows.map((row) => (
          <li key={keyOfRow(row)} data-testid={`minutes-${row[1]}`}>
            <input
              type="number"
              step={60}
              aria-label={`minutes for ${row[1]}`}
              data-testid={`minutes-input-${row[1]}`}
              value={editing?.key === keyOfRow(row) ? editing.value : row[2]}
              readOnly={!view.canWriteColumn(2)}
              onChange={(e) => setEditing({ key: keyOfRow(row), value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit(row)
              }}
              onBlur={() => commit(row)}
            />
            <span>{row[1]}</span>
            <span className="muted">{row[0]}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** `Missing(path, title, tag) :- Doc(path, title), Vocab(tag), !MdTag(path, tag).`
 *
 *  The only view here defined by what is *absent*, and the only one whose
 *  backward direction runs the other way round. Everywhere else a row goes away
 *  when a fact is deleted; a `Missing` row goes away when a fact is *added*, and
 *  appears when one is deleted. Nothing declares that. A negated atom flips
 *  which channel a request travels on, so `Del_Missing` compiles to
 *  `Ins_MdTag` and `Ins_Missing` to `Del_MdTag`.
 *
 *  A checkbox is the right control precisely because it exercises both: ticking
 *  removes a row from the view, unticking puts one back, and the two land on
 *  opposite channels.
 *
 *  `.put into MdTag` keeps the flip on its own. Without it, deleting the
 *  document's heading is also a way to make the row stop existing — true, and
 *  not what a tick means. */
function TagMatrix({ write }: { write: Write }) {
  const view = useWritableQuery<readonly [string, string, string]>(store, 'Missing')
  const docs = useLiveQuery<readonly [string, string]>(store, 'Doc')
  const notes = useMemo(() => [...docs].sort((a, b) => a[0].localeCompare(b[0])), [docs])
  // A pair is *tagged* exactly when it is not in `Missing`. The grid is the
  // complement of the view, which is why every cell is a write to it.
  const missing = useMemo(
    () => new Set(view.rows.map((r) => `${r[0]}/${r[2]}`)),
    [view.rows],
  )

  const toggle = (path: string, title: string, tag: string, tagged: boolean) => {
    const row: readonly [string, string, string] = [path, title, tag]
    // A tick has one meaning, so anything with more than one answer is a
    // question rather than an instruction. With `.put into MdTag` there is
    // exactly one; take the annotation away and the engine finds three, which
    // is the point of asking.
    const opts = { dryRun: true, requireUnambiguous: true } as const
    tagged
      ? // Currently tagged ⇒ the pair is absent from `Missing`; putting it back
        // means deleting the fact.
        write(`untagged ${path} #${tag}`, () => view.insert(row, opts))
      : write(`tagged ${path} #${tag}`, () => view.remove(row, opts))
  }

  return (
    <section className="card">
      <h2>Tags</h2>
      <p className="muted">
        <code>Missing(p, title, g) :- Doc(p, title), Vocab(g), !MdTag(p, g).</code> A view of
        what is <em>not</em> there. A box is ticked when the pair is absent from it, so
        ticking one <em>removes</em> a row from the view — and the way to remove a row from
        a negated view is to add a fact. Unticking adds a row, by deleting one. The rules
        are the only place that is written down.
      </p>
      <table className="agenda" data-testid="tag-table">
        <thead>
          <tr>
            <th>note</th>
            {VOCAB.map((tag) => (
              <th key={tag}>#{tag}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {notes.map(([path, title]) => (
            <tr key={path} data-testid={`tags-${path}`}>
              <td>{title}</td>
              {VOCAB.map((tag) => {
                const tagged = !missing.has(`${path}/${tag}`)
                return (
                  <td key={tag}>
                    <input
                      type="checkbox"
                      aria-label={`${tag} on ${path}`}
                      data-testid={`tag-${path}-${tag}`}
                      checked={tagged}
                      onChange={() => toggle(path, title, tag, tagged)}
                    />
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

/** `Line(path, text) :- MdTask(path, line, status, text).`
 *  `Line(path, text) :- MdHeading(path, line, depth, text).`
 *
 *  Two rules for one head. *Reading* needs no choice — every row came from one
 *  rule or the other, and replaying the body says which, so editing and
 *  removing a line work with nothing declared. *Adding* one has no body to
 *  replay and therefore no way to ask: a new line is a task under one rule and
 *  a heading under the other, and the program does not prefer either.
 *
 *  `.put insert via MdTask` picks the rule, and `defaults(l = 0, s = "open")`
 *  fills the two columns that rule needs and the head does not carry. */
function LineTable({ write }: { write: Write }) {
  const view = useWritableQuery<readonly [string, string]>(store, 'Line')
  const [adding, setAdding] = useState('')
  const [target, setTarget] = useState('work.md')
  const rows = useMemo(
    () => [...view.rows].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])),
    [view.rows],
  )
  const notes = useMemo(() => [...new Set(rows.map((r) => r[0]))].sort(), [rows])

  // Whether adding is possible at all is a question about the program, and the
  // only honest way to answer it is to ask the engine. A dry run resolves and
  // verifies without applying anything, so this is the real answer rather than
  // a guess about which annotations are present.
  const probe = useMemo(
    () => view.insert([target, adding.trim() || 'a new line'], { dryRun: true }),
    [view, target, adding],
  )
  const canAdd = probe.status === 'ok'

  const add = () => {
    const text = adding.trim()
    if (!text) return
    write(`added "${text}"`, () => view.insert([target, text], { dryRun: true }))
    setAdding('')
  }

  return (
    <section className="card">
      <h2>Lines</h2>
      <p className="muted">
        <code>Line(path, text) :- MdTask(path, line, status, text).</code>
        <br />
        <code>Line(path, text) :- MdHeading(path, line, depth, text).</code> One view, two
        rules. Editing a row works without anything declared — the row exists, so replaying
        the body says which rule it came from. Adding one has no row to replay, and a new
        line is a task under one rule and a heading under the other.
      </p>
      <ul className="tasks" data-testid="line-list">
        {rows.map((row) => (
          <li key={`${row[0]}/${row[1]}`} data-testid={`line-${row[1]}`}>
            <span>{row[1]}</span>
            <span className="muted">{row[0]}</span>
          </li>
        ))}
      </ul>
      <div className="task-add">
        <input
          aria-label="new line"
          data-testid="line-new-text"
          placeholder="add a line…"
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canAdd) add()
          }}
        />
        <select
          aria-label="note for new line"
          data-testid="line-new-note"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          {notes.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-testid="line-add"
          onClick={add}
          disabled={!adding.trim() || !canAdd}
          title={canAdd ? 'inserts via MdTask' : reasonOf(probe)}
        >
          add
        </button>
      </div>
      <p className="muted" data-testid="line-insert-status">
        {canAdd
          ? '.put insert via MdTask defaults(l = 0, s = "open") — a new line is a task.'
          : reasonOf(probe)}
      </p>
    </section>
  )
}

/** `/vault/shapes` — the cases where the backward direction is a different
 *  shape, not just a different address. */
export function ShapesPage() {
  const { write } = useVault()
  return (
    <>
      <EffortTable write={write} />
      <MinutesTable write={write} />
      <TagMatrix write={write} />
      <LineTable write={write} />
    </>
  )
}
