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

import { useCallback, useMemo, useState } from 'react'
import { Store, useProgram, useWritableQuery } from '@flow-ts/react'
import type { Resolution } from 'flow-ts'
import { SEED_NOTES, SOURCE, program } from './vault/program.js'
import { parseProgram } from '@flow-ts/parsing'
import { type Row, type VaultFacts, applyToVault, parseVault } from './vault/markdown.js'

// Only these views are writable. The others are just as derived; they simply
// aren't opted in, because shadow rules aren't free and most tables are read.
const store = new Store(program, { writable: ['Task', 'Agenda', 'Outline'] })

const EDBS = ['MdTask', 'MdHeading'] as const
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

let currentFacts: VaultFacts = { MdTask: [], MdHeading: [] }

export function VaultDemo() {
  const [notes, setNotes] = useState<Record<string, string>>(SEED_NOTES)
  const [status, setStatus] = useState<string | null>(null)
  useProgram(store)

  // Keep the engine's facts in step with the text. Doing this during render is
  // fine here because it is idempotent — the diff is empty once they agree.
  const facts = useMemo(() => parseVault(notes), [notes])
  if (facts !== currentFacts) {
    syncFacts(currentFacts, facts)
    currentFacts = facts
  }

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
      setStatus(
        `${what}: rewrote ${r.changes
          .map((c) => `${c.rel}(${c.row.slice(0, 2).join(':')})`)
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

      <VaultProgramPanel />

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
          <AgendaTable write={write} />
          <OutlineTable write={write} />
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
function VaultProgramPanel() {
  const [draft, setDraft] = useState<string>(SOURCE.trim())
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)

  const rebuild = () => {
    try {
      store.replaceProgram(parseProgram(draft, { grammarSource: 'live.dl' }))
      setError(null)
      setDirty(false)
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
            setDirty(e.target.value.trim() !== SOURCE.trim())
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
              setDraft(SOURCE.trim())
              setError(null)
              setDirty(false)
              store.replaceProgram(parseProgram(SOURCE, { grammarSource: 'vault.dl' }))
            }}
            disabled={draft.trim() === SOURCE.trim()}
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

const reasonOf = (r: Resolution): string =>
  r.status === 'ambiguous' || r.status === 'refused' || r.status === 'unsatisfied'
    ? r.reason
    : ''

/** `Task(path, status, text) :- MdTask(path, line, status, text).`
 *  A projection: `line` is gone, and a write has to recover it. */
function TaskTable({ write }: { write: Write }) {
  const view = useWritableQuery<readonly [string, string, string]>(store, 'Task')
  const rows = useMemo(
    () => [...view.rows].sort((a, b) => a[0].localeCompare(b[0]) || a[2].localeCompare(b[2])),
    [view.rows],
  )
  return (
    <section className="card">
      <h2>Tasks</h2>
      <p className="muted">
        <code>Task(path, status, text) :- MdTask(path, line, status, text).</code> The line
        number is projected away, so a write has to find it again.
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
    </section>
  )
}

/** `Agenda(title, text) :- Open(p, t), Doc(p, title).` — a join whose two
 *  columns write into two different source relations, three rules apart. */
function AgendaTable({ write }: { write: Write }) {
  const view = useWritableQuery<readonly [string, string]>(store, 'Agenda')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const rows = useMemo(
    () => [...view.rows].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])),
    [view.rows],
  )
  const commit = (row: readonly [string, string], col: 0 | 1) => {
    const k = `${col}/${row[0]}/${row[1]}`
    const next = (draft[k] ?? row[col]).trim()
    if (!next || next === row[col]) return
    const target: [string, string] = col === 0 ? [next, row[1]] : [row[0], next]
    write(`renamed "${row[col]}" → "${next}"`, () => view.update(row, target, { dryRun: true }))
    setDraft((d) => ({ ...d, [k]: '' }))
  }
  return (
    <section className="card">
      <h2>Agenda</h2>
      <p className="muted">
        <code>Agenda(title, text) :- Open(p, t), Doc(p, title).</code> Two columns, two
        destinations: the title is a heading, the text is a task line. Writable columns:{' '}
        <span data-testid="agenda-writable">[{view.writableColumns.join(', ')}]</span>
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
                    value={draft[`${col}/${row[0]}/${row[1]}`] ?? row[col]}
                    readOnly={!view.canWriteColumn(col)}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, [`${col}/${row[0]}/${row[1]}`]: e.target.value }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commit(row, col)
                    }}
                    onBlur={() => commit(row, col)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
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
