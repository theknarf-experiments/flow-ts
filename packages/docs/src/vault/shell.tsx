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
// The markdown half stays outside the engine on purpose. Facts are values, so
// nothing positional crosses the boundary, and a write re-reads the current
// text to find its line. Byte offsets would have gone stale the moment anything
// above them moved.
//
// This module is the part every page shares: the store, the notes, the program,
// and the one function that turns a `Resolution` into rewritten markdown. The
// tables themselves live on three pages, because there are now a lot of them
// and they are not all making the same point:
//
//   /vault           tracing a write back to the fact behind it
//   /vault/shapes    views whose inverse is not a copy
//   /vault/opt-in    what gets compiled, and what that costs

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { NavLink, Outlet } from 'react-router'

/** `NavLink` hands its className a function; the subnav only wants `active`. */
const subnavClass = ({ isActive }: { isActive: boolean }) =>
  isActive ? 'active' : undefined
import { Store, useProgram } from '@flow-ts/react'
import type { Resolution } from 'flow-ts'
import { parseProgram } from 'flow-ts'
import { AGENDA_INTO, SEED_NOTES, SOURCE, VOCAB, program } from './program.js'
import { type Row, type VaultFacts, applyToVault, parseVault } from './markdown.js'

// Only these views are writable. The others are just as derived; they simply
// aren't opted in, because shadow rules aren't free and most tables are read.
export const store = new Store(program, {
  writable: ['Task', 'Agenda', 'Outline', 'Effort', 'Line', 'Load', 'Minutes', 'Missing'],
})

// The tag palette is the application's, not the notes' — see the note in
// program.ts on why deriving it from the tags in use breaks the insert
// direction. It never changes, so it is seeded once.
for (const tag of VOCAB) store.collection('Vocab').insert([tag] as never)
store.flush()

const EDBS = ['MdTask', 'MdHeading', 'MdEstimate', 'MdTag'] as const
const keyOf = (row: Row) => row.map((v) => `${typeof v}:${v}`).join('')

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

/** Trace an edit to the facts behind it, then rewrite the markdown. */
export type Write = (what: string, resolve: () => Resolution) => void

interface VaultState {
  notes: Record<string, string>
  facts: VaultFacts
  write: Write
  /** Add `.put into Open` to the live program — offered by the Agenda table
   *  when it finds a delete it will not choose between. */
  annotateAgenda: () => void
}

const VaultContext = createContext<VaultState | null>(null)

export function useVault(): VaultState {
  const ctx = useContext(VaultContext)
  /* c8 ignore next */
  if (!ctx) throw new Error('useVault outside the vault layout')
  return ctx
}

/** The layout every vault page renders inside: the notes, the program, and the
 *  status line, all of which are shared. Only the tables differ per page. */
export function VaultShell() {
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

  const write = useCallback<Write>(
    (what, resolve) => {
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

  const annotateAgenda = useCallback(() => {
    setSource((s) =>
      s.includes(AGENDA_INTO.line)
        ? s
        : s.replace(AGENDA_INTO.after, `${AGENDA_INTO.after}\n${AGENDA_INTO.line}`),
    )
  }, [])

  const value = useMemo<VaultState>(
    () => ({ notes, facts, write, annotateAgenda }),
    [notes, facts, write, annotateAgenda],
  )

  return (
    <VaultContext.Provider value={value}>
      <main className="app" data-testid="vault-demo">
        <header>
          <h1>Markdown vault</h1>
          <p className="muted">
            Notes are lowered to facts and queried by rule. The tables are derived — and
            editable. An edit is traced back through the rules to the fact it came from, and
            that fact is rewritten in the markdown on the left.
          </p>
          <nav className="subnav" data-testid="vault-subnav">
            <NavLink to="/vault" end className={subnavClass}>
              Tracing
            </NavLink>
            <NavLink to="/vault/shapes" className={subnavClass}>
              Shapes
            </NavLink>
            <NavLink to="/vault/opt-in" className={subnavClass}>
              Opt-in
            </NavLink>
          </nav>
        </header>

        <VaultProgramPanel source={source} setSource={setSource} />

        <div className="vault-grid">
          <section className="card">
            <h2>Notes</h2>
            {Object.entries(notes).map(([path, text]) => (
              <label key={path} className="note">
                <span className="note-path">{path}</span>
                <textarea
                  data-testid={`note-${path}`}
                  value={text}
                  rows={text.split('\n').length + 1}
                  onChange={(e) => setNotes((n) => ({ ...n, [path]: e.target.value }))}
                />
              </label>
            ))}
          </section>

          <div className="vault-views">
            <Outlet />
            {status && (
              <p className="muted" data-testid="vault-status">
                {status}
              </p>
            )}
          </div>
        </div>
      </main>
    </VaultContext.Provider>
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

/** Column names for a relation, so writability can be reported in the reader's
 *  terms rather than as indices. */
export function columnNames(relation: string): string[] {
  const decl = store.program.idbs.find((d) => d.name === relation)
  return decl?.attributes.map((a) => a.name) ?? []
}

export const reasonOf = (r: Resolution): string =>
  r.status === 'ambiguous' || r.status === 'refused' || r.status === 'unsatisfied'
    ? r.reason
    : ''
