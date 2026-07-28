// Tracing a write back to the fact behind it.
//
// The three views here have inverses that are *copies*: one view cell traces to
// one source position, and all the work is finding which. That is the ordinary
// case and the reason the whole thing exists — `Agenda(title, text)` is a join
// over `Open`, which is a filtered projection of `MdTask`, and `Doc` is itself
// derived from a heading, so editing a title travels through two rules to land
// on a `#` line. Nothing here tells it how; the rules are the only description
// of the mapping that exists.

import { useMemo, useState } from 'react'
import { useWritableQuery } from '@flow-ts/react'
import type { Row } from './markdown.js'
import { type Write, columnNames, reasonOf, store, useVault } from './shell.js'

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

/** `/vault` — the ordinary case, where the inverse is a copy. */
export function TracingPage() {
  const { write, annotateAgenda } = useVault()
  return (
    <>
      <TaskTable write={write} />
      <AgendaTable write={write} annotate={annotateAgenda} />
      <OutlineTable write={write} />
    </>
  )
}
