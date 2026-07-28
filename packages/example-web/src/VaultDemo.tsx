// A markdown vault as a live Datalog notebook — flow-md's idea, in miniature,
// and the reason backward propagation exists.
//
// Notes are the source of truth. They are lowered to facts, queried by rule,
// and the results are rendered as tables you can edit. An edit to a *derived*
// row is traced back to the fact it came from, that fact is rewritten in the
// markdown, and the whole thing is re-parsed. So the arrow runs both ways:
//
//   markdown ──parse──▶ facts ──rules──▶ views
//   markdown ◀──write── facts ◀─shadow── an edit to a view
//
// The engine's half is the interesting one. `Agenda(title, text)` is a join
// over `Open`, which is a filtered projection of `MdTask`, and `Doc` is itself
// derived from the first heading — so editing a title in the agenda has to
// travel through two rules to land on a `#` line, and editing the text has to
// recover the line number that `Open` threw away. Nothing here tells it how;
// the rules are the only description of the mapping that exists.
//
// The markdown half stays outside the engine on purpose. Facts are values, so
// nothing positional crosses the boundary, and a write re-reads the current
// text to find its line. Byte offsets would have gone stale the moment anything
// above them moved.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Store, useLiveQuery, useProgram, useWritableQuery } from '@flow-ts/react'
import type { Resolution } from 'flow-ts'
import { AGENDA_INTO, SEED_NOTES, SOURCE, VOCAB, program } from './vault/program.js'
import { parseProgram } from '@flow-ts/parsing'
import { type Row, type VaultFacts, applyToVault, parseVault } from './vault/markdown.js'

// Only these views are writable. The others are just as derived; they simply
// aren't opted in, because shadow rules aren't free and most tables are read.
const store = new Store(program, {
  writable: ['Task', 'Agenda', 'Outline', 'Effort', 'Line', 'Load', 'Minutes', 'Missing'],
})

// The tag palette is the application's, not the notes' — see the note in
// program.ts on why deriving it from the tags in use breaks the insert
// direction. It never changes, so it is seeded once.
for (const tag of VOCAB) store.collection('Vocab').insert([tag] as never)
store.flush()

const EDBS = ['MdTask', 'MdHeading', 'MdEstimate', 'MdTag'] as const
const keyOf = (row: Row) => row.map((v) => `${typeof v}:${v}`).join('')

/** Push a new set of facts into the store as a diff, so derivations update
 *  incrementally rather than being rebuilt. */
function syncFacts(prev: VaultFacts, next: VaultFacts): void {
  for (const rel of EDBS) {
    const before = new Map(prev[rel].map((r) => [keyOf(r), r]))
    const after = new Map(next[rel].map((r) => [keyOf(r), r]))
    const collection = store.collection(rel)
    for (const [k, row] of before) if (!after.has(k)) collection.delete(row as never)
    for (const [k, row] of after) if (!before.has(k)) collection.insert(row as never)
  }
  store.flush()
}

const EMPTY: VaultFacts = { MdTask: [], MdHeading: [], MdEstimate: [], MdTag: [] }

export function VaultDemo() {
  const [notes, setNotes] = useState<Record<string, string>>(SEED_NOTES)
  const [status, setStatus] = useState<string | null>(null)
  // The active program lives here rather than in the panel, because the panel
  // is no longer the only thing that edits it: the Agenda table offers to add
  // an annotation, and that has to be the same edit the panel would show.
  const [source, setSource] = useState<string>(SOURCE.trim())
  useProgram(store)

  useEffect(() => {
    store.replaceProgram(parseProgram(source, { grammarSource: 'live.dl' }))
  }, [source])

  // Keep the engine's facts in step with the text — in an effect, not during
  // render. `syncFacts` flushes the store, which notifies subscribers, and
  // notifying a subscriber mid-render updates a sibling component while this
  // one is still rendering. React warns about it, and the reason it warns is
  // that the sibling can read a half-applied snapshot: a row would show a
  // title the facts no longer agreed with.
  const facts = useMemo(() => parseVault(notes), [notes])
  const applied = useRef<VaultFacts>(EMPTY)
  useEffect(() => {
    syncFacts(applied.current, facts)
    applied.current = facts
  }, [facts])

  /** Trace an edit to the facts behind it, then rewrite the markdown. */
  const write = useCallback(
    (what: string, resolve: () => Resolution) => {
      const r = resolve()
      if (r.status !== 'ok') {
        setStatus(
          r.status === 'ambiguous'
            ? `${what}: ambiguous — ${r.candidates.length} ways to do it`
            : `${what}: ${r.reason}`,
        )
        return
      }
      // The engine named facts; the markdown is what actually changes.
      let next = notes
      for (const change of r.changes) {
        const applied = applyToVault(next, change)
        if ('reason' in applied) {
          setStatus(`${what}: ${applied.reason}`)
          return
        }
        next = applied
      }
      setNotes(next)
      // The channel is worth naming, not just the relation. It is the only
      // visible sign that a negated view runs backwards: ticking a tag box
      // removes a row from `Missing` by *inserting* a fact, and reading
      // "rewrote MdTag" would hide exactly the thing worth seeing.
      setStatus(
        `${what}: ${r.changes
          .map((c) => `${c.kind} ${c.rel}(${c.row.slice(0, 2).join(':')})`)
          .join(', ')}`,
      )
    },
    [notes],
  )

  return (
    <main className="app" data-testid="vault-demo">
      <header>
        <h1>Markdown vault</h1>
        <p className="muted">
          Notes are lowered to facts and queried by rule. The tables are derived — and
          editable. An edit is traced back through the rules to the fact it came from, and
          that fact is rewritten in the markdown on the left.
        </p>
      </header>

      <VaultProgramPanel source={source} setSource={setSource} />

      <div className="vault-grid">
        <section className="card">
          <h2>Notes</h2>
          {Object.entries(notes).map(([path, source]) => (
            <label key={path} className="note">
              <span className="note-path">{path}</span>
              <textarea
                data-testid={`note-${path}`}
                value={source}
                rows={source.split('\n').length + 1}
                onChange={(e) => setNotes((n) => ({ ...n, [path]: e.target.value }))}
              />
            </label>
          ))}
        </section>

        <div className="vault-views">
          <TaskTable write={write} />
          <AgendaTable
            write={write}
            annotate={() =>
              setSource((s) =>
                s.includes(AGENDA_INTO.line)
                  ? s
                  : s.replace(AGENDA_INTO.after, `${AGENDA_INTO.after}\n${AGENDA_INTO.line}`),
              )
            }
          />
          <OutlineTable write={write} />
          <EffortTable write={write} />
          <LineTable write={write} />
          <LoadTable />
          <MinutesTable write={write} />
          <TagMatrix write={write} />
          {status && (
            <p className="muted" data-testid="vault-status">
              {status}
            </p>
          )}
        </div>
      </div>
    </main>
  )
}

/** The rules, editable. Everything above is derived from these — including
 *  which cells are editable at all — so changing them here changes the whole
 *  demo, write-back included. */
function VaultProgramPanel({
  source,
  setSource,
}: {
  source: string
  setSource: (next: string) => void
}) {
  const [draft, setDraft] = useState<string>(source)
  const [error, setError] = useState<string | null>(null)
  const dirty = draft !== source
  // The panel is not the only editor any more, so the draft follows the active
  // program when something else changes it.
  useEffect(() => setDraft(source), [source])

  const rebuild = () => {
    try {
      // Parsed here only to keep a broken draft out of the active source; the
      // effect that owns `replaceProgram` parses the copy it commits.
      parseProgram(draft, { grammarSource: 'live.dl' })
      setError(null)
      setSource(draft)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <section className="program">
      <details data-testid="vault-program-panel">
        <summary>Datalog program</summary>
        <p className="muted">
          The tables above are these rules. Editing them changes what is derived <em>and</em>{' '}
          what can be written back — a column stops being editable the moment it no longer
          traces to a single source position.
        </p>
        <textarea
          className="program-editor"
          data-testid="vault-program-source"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            setError(null)
          }}
          spellCheck={false}
          rows={Math.min(24, draft.split('\n').length + 1)}
        />
        <div className="program-actions">
          <button data-testid="vault-program-rebuild" onClick={rebuild} disabled={!dirty}>
            rebuild
          </button>
          <button
            data-testid="vault-program-reset"
            onClick={() => {
              setError(null)
              setSource(SOURCE.trim())
            }}
            disabled={draft === SOURCE.trim() && source === SOURCE.trim()}
          >
            reset
          </button>
          <span className="program-status" data-testid="vault-program-status">
            {error ? <span className="program-error">{error}</span> : null}
          </span>
        </div>
      </details>
    </section>
  )
}

type Write = (what: string, resolve: () => Resolution) => void

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

/** Column names for a relation, so writability can be reported in the reader's
 *  terms rather than as indices. */
function columnNames(relation: string): string[] {
  const decl = store.program.idbs.find((d) => d.name === relation)
  return decl?.attributes.map((a) => a.name) ?? []
}

const reasonOf = (r: Resolution): string =>
  r.status === 'ambiguous' || r.status === 'refused' || r.status === 'unsatisfied'
    ? r.reason
    : ''

/** `Task(path, status, text) :- MdTask(path, line, status, text).`
 *  A projection: `line` is gone, and a write has to recover it. */
function TaskTable({ write }: { write: Write }) {
  const view = useWritableQuery<readonly [string, string, string]>(store, 'Task')
  const [adding, setAdding] = useState('')
  const rows = useMemo(
    () => [...view.rows].sort((a, b) => a[0].localeCompare(b[0]) || a[2].localeCompare(b[2])),
    [view.rows],
  )
  const notes = useMemo(() => [...new Set(rows.map((r) => r[0]))].sort(), [rows])
  const [target, setTarget] = useState('work.md')

  const add = () => {
    const text = adding.trim()
    if (!text) return
    write(`added "${text}"`, () => view.insert([target, 'open', text], { dryRun: true }))
    setAdding('')
  }

  return (
    <section className="card">
      <h2>Tasks</h2>
      <p className="muted">
        <code>Task(path, status, text) :- MdTask(path, line, status, text).</code> The line
        number is projected away, so a write has to find it again — and an <em>insert</em>{' '}
        has no row to find it from, which is the one thing here that needs an annotation.
      </p>
      <ul className="tasks" data-testid="task-list">
        {rows.map((row) => (
          <li key={`${row[0]}/${row[2]}`} data-testid={`task-${row[2]}`}>
            <input
              type="checkbox"
              aria-label={`toggle ${row[2]}`}
              data-testid={`task-check-${row[2]}`}
              checked={row[1] === 'closed'}
              disabled={!view.canWriteColumn(1)}
              onChange={() =>
                write(`toggled "${row[2]}"`, () =>
                  view.update(row, [row[0], row[1] === 'closed' ? 'open' : 'closed', row[2]], {
                    dryRun: true,
                  }),
                )
              }
            />
            <span className={row[1] === 'closed' ? 'done' : undefined}>{row[2]}</span>
            <span className="muted">{row[0]}</span>
          </li>
        ))}
      </ul>
      <div className="task-add">
        <input
          aria-label="new task"
          data-testid="task-new-text"
          placeholder="add a task…"
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
        />
        <select
          aria-label="note"
          data-testid="task-new-note"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          {notes.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button type="button" data-testid="task-add" onClick={add} disabled={!adding.trim()}>
          add
        </button>
      </div>
      <p className="muted">
        Adding needs <code>.put insert defaults(l = 0)</code> in the program: there is no
        row to replay, so nothing determines the line. The convention — 0 means append, the
        real number comes back from the re-parse — is the schema's to state, not the
        engine's to guess. Delete it from the program below and this control stops working.
      </p>
    </section>
  )
}

/** `Agenda(title, text) :- Open(p, t), Doc(p, title).` — a join whose two
 *  columns write into two different source relations, three rules apart. */
function AgendaTable({ write, annotate }: { write: Write; annotate: () => void }) {
  const view = useWritableQuery<readonly [string, string]>(store, 'Agenda')
  // One cell at a time. Keying drafts by the row's *values* meant an entry
  // outlived the row it belonged to the moment a rename changed those values,
  // and a later row with the same values would inherit it.
  const [editing, setEditing] = useState<{ key: string; value: string } | null>(null)
  // When a delete can be done more than one way, the choice is the user's.
  const [choice, setChoice] = useState<{
    what: string
    candidates: ReadonlyArray<{ kind: string; rel: string; row: Row; newRow?: Row }>
  } | null>(null)
  const rows = useMemo(
    () => [...view.rows].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])),
    [view.rows],
  )
  const cellKey = (row: readonly [string, string], col: 0 | 1) => `${col}/${row[0]}/${row[1]}`
  const commit = (row: readonly [string, string], col: 0 | 1) => {
    const k = cellKey(row, col)
    if (!editing || editing.key !== k) return
    const next = editing.value.trim()
    setEditing(null)
    if (!next || next === row[col]) return
    const target: [string, string] = col === 0 ? [next, row[1]] : [row[0], next]
    write(`renamed "${row[col]}" → "${next}"`, () => view.update(row, target, { dryRun: true }))
  }
  return (
    <section className="card">
      <h2>Agenda</h2>
      <p className="muted">
        <code>Agenda(title, text) :- Open(p, t), Doc(p, title).</code> Two columns, two
        destinations: editing the title rewrites a heading, editing the text rewrites a task
        line. Both are editable here — a document's title is shared by every task in it, so
        renaming one row renames the others too.{' '}
        Removing is where they part company — see below.{' '}
        <span data-testid="agenda-writable">
          editable: {view.writableColumns.map((i) => columnNames('Agenda')[i] ?? i).join(', ') || 'none'}
        </span>
      </p>
      <table className="agenda" data-testid="agenda-table">
        <thead>
          <tr>
            <th>document</th>
            <th>open task</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row[0]}/${row[1]}`} data-testid={`agenda-${row[1]}`}>
              {([0, 1] as const).map((col) => (
                <td key={col}>
                  <input
                    aria-label={`edit ${row[col]}`}
                    data-testid={`agenda-input-${col}-${row[1]}`}
                    value={
                      editing?.key === cellKey(row, col) ? editing.value : row[col]
                    }
                    readOnly={!view.canWriteColumn(col)}
                    onChange={(e) =>
                      setEditing({ key: cellKey(row, col), value: e.target.value })
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commit(row, col)
                    }}
                    onBlur={() => commit(row, col)}
                  />
                </td>
              ))}
              <td>
                <button
                  type="button"
                  data-testid={`agenda-remove-${row[1]}`}
                  onClick={() => {
                    const r = view.remove(row, { dryRun: true, requireUnambiguous: true })
                    if (r.status === 'ambiguous') {
                      setChoice({ what: `remove "${row[1]}"`, candidates: r.candidates })
                      return
                    }
                    write(`removed "${row[1]}"`, () => r)
                  }}
                >
                  remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {choice && (
        <div className="choice" data-testid="agenda-choice">
          <p className="muted">
            <strong>{choice.what}</strong> can be done {choice.candidates.length} ways. The
            engine found them all and will not pick for you — removing the heading is a
            perfectly good way to make the row stop existing, and almost certainly not what
            you meant.
          </p>
          {choice.candidates.map((c) => (
            <button
              type="button"
              key={`${c.rel}/${c.row.join(',')}`}
              data-testid={`agenda-choice-${c.rel}`}
              onClick={() => {
                setChoice(null)
                write(choice.what, () => ({ status: 'ok', changes: [c as never], rounds: 1 }))
              }}
            >
              {c.rel === 'MdTask' ? 'remove the task line' : 'remove the document heading'}{' '}
              <span className="muted">
                {c.rel}({c.row.join(', ')})
              </span>
            </button>
          ))}
          <button type="button" data-testid="agenda-choice-cancel" onClick={() => setChoice(null)}>
            cancel
          </button>
          <p className="muted">
            Or answer it once, in the schema. <code>.put into Open</code> on{' '}
            <code>Agenda</code> names the side of the join a write lands on; the other side
            is held constant, which is the classical condition for a view update to be
            well-defined. It is not free — holding <code>Doc</code> constant is exactly what
            makes the title column read-only, and you can watch that happen.
          </p>
          <button
            type="button"
            data-testid="agenda-choice-annotate"
            onClick={() => {
              setChoice(null)
              annotate()
            }}
          >
            add <code>.put into Open</code> to the program
          </button>
        </div>
      )}
    </section>
  )
}

/** `Outline(title, depth, text) :- MdHeading(p, l, d, t), Doc(p, title).`
 *  `depth` is a number the writer turns back into a run of `#`. */
function OutlineTable({ write }: { write: Write }) {
  const view = useWritableQuery<readonly [string, number, string]>(store, 'Outline')
  // `writableColumns` says the depth column is editable in general. Whether it
  // is editable for *this* row is a question about the data, and the only way
  // to answer it is to try: a dry run resolves and verifies without applying.
  // `# Home` fails, because the heading that would be demoted is also the one
  // deriving the document's title — so the row would lose the title it is
  // filed under. `## This week` succeeds, because its title comes from a
  // different line.
  const rows = useMemo(
    () =>
      [...view.rows]
        .sort((a, b) => a[0].localeCompare(b[0]) || a[2].localeCompare(b[2]))
        .map((row) => {
          const probe = view.update(row, [row[0], row[1] + 1, row[2]], { dryRun: true })
          return { row, ok: probe.status === 'ok', why: probe.status === 'ok' ? '' : reasonOf(probe) }
        }),
    [view],
  )
  return (
    <section className="card">
      <h2>Outline</h2>
      <p className="muted">
        <code>Outline(title, depth, text) :- MdHeading(p, l, d, t), Doc(p, title).</code>{' '}
        Changing a depth rewrites the run of <code>#</code> — the number is stored, the
        syntax is not.
      </p>
      <ul className="outline" data-testid="outline-list">
        {rows.map(({ row, ok, why }) => (
          <li key={`${row[0]}/${row[2]}`} data-testid={`outline-${row[2]}`}>
            <button
              type="button"
              data-testid={`outline-deeper-${row[2]}`}
              disabled={!ok || row[1] >= 6}
              title={ok ? 'rewrites the run of # on that line' : why}
              onClick={() =>
                write(`indented "${row[2]}"`, () =>
                  view.update(row, [row[0], row[1] + 1, row[2]], { dryRun: true }),
                )
              }
            >
              ›
            </button>
            <span data-testid={`outline-depth-${row[2]}`}>{'#'.repeat(row[1])}</span> {row[2]}
            {!ok && (
              <span className="muted" data-testid={`outline-why-${row[2]}`}>
                can't deepen — it is this document's title
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
