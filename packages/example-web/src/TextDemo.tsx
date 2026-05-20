// CRDT text editor backed by the RGA-like list CRDT Datalog query in
// `textProgram.ts`. Each keystroke becomes an `Insert(rep_id, ctr,
// parent_rep, parent_ctr, value)`; backspace emits a `Remove(rep, ctr)`.
// The rendered text comes from walking the derived `ListElem` linked
// list from the sentinel `(0, 0)` — so what you see in the textarea is
// literally the IDB result, not local React state.
//
// This isn't a proper editor (no cursor positioning, no IME support,
// no undo) — it's a demo to show CRDT ops driving live derived state.
// Scope: append + backspace at the end of the document.

import { useEffect, useMemo, useRef, type ChangeEvent } from 'react'
import { Store, useLiveQuery, useProgram } from '@flow-ts/react'
import { RelationTable } from './components/RelationTable.js'
import { textProgram, TEXT_SOURCE } from './textProgram.js'

type InsertRow = readonly [number, number, number, number, string]
type RemoveRow = readonly [number, number]
type ListElemRow = readonly [number, number, string, number, number]

type ElemId = readonly [number, number]

const REPLICA_ID = 1
const SENTINEL: ElemId = [0, 0]

const store = new Store(textProgram)
const inserts = store.collection<InsertRow>('Insert')
const removes = store.collection<RemoveRow>('Remove')

/** Index `ListElem` rows by their "prev" pointer so we can walk the
 *  linked list in O(n) starting at the sentinel. */
function indexByPrev(elems: ReadonlyArray<ListElemRow>): Map<string, ListElemRow> {
  const out = new Map<string, ListElemRow>()
  for (const e of elems) out.set(`${e[0]},${e[1]}`, e)
  return out
}

/** Reconstruct the rendered text by walking the linked list from the
 *  sentinel. Each `ListElem(prev, value, next)` row says "the element
 *  AFTER `prev` is `next`, and its character is `value`." Returns both
 *  the assembled string and the in-order list of visible-element ids. */
function renderText(elems: ReadonlyArray<ListElemRow>): {
  text: string
  tail: ElemId[]
} {
  const byPrev = indexByPrev(elems)
  let cur = byPrev.get(`${SENTINEL[0]},${SENTINEL[1]}`)
  let text = ''
  const tail: ElemId[] = []
  while (cur) {
    const [, , value, nextR, nextC] = cur
    text += value
    tail.push([nextR, nextC])
    cur = byPrev.get(`${nextR},${nextC}`)
  }
  return { text, tail }
}

export function TextDemo(): JSX.Element {
  // Counter for generating fresh `(rep, ctr)` ids.
  const ctrRef = useRef<number>(0)
  const nextCtr = () => ++ctrRef.current

  const elems = useLiveQuery<ListElemRow>(store, 'ListElem')
  const text = useMemo(() => renderText(elems), [elems])

  // Synchronous "what we've typed so far" mirror. The CRDT mirror in
  // `text` updates only after a microtask flush, but the textarea
  // fires onChange synchronously for every keystroke — so we'd compute
  // the diff against stale state and end up double-inserting. The
  // `typedRef` + `visibleTailRef` pair tracks the local view of the
  // CRDT *as if* every emitted op had already been applied. A useEffect
  // resyncs them with the real CRDT state once the microtask lands.
  const typedRef = useRef<string>('')
  // Visible-tail = ids of each currently-visible character, in order.
  // On insert we push; on backspace we pop and emit a Remove for it.
  const visibleTailRef = useRef<ElemId[]>([])

  useEffect(() => {
    typedRef.current = text.text
    visibleTailRef.current = text.tail
  }, [text])

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value
    const prev = typedRef.current
    if (next === prev) return

    if (next.startsWith(prev)) {
      // Append. Each new char's parent is the previous tail element,
      // which advances synchronously as we insert.
      const suffix = next.slice(prev.length)
      for (const ch of suffix) {
        const tail = visibleTailRef.current
        const parent = tail.length > 0 ? tail[tail.length - 1]! : SENTINEL
        const ctr = nextCtr()
        const id: ElemId = [REPLICA_ID, ctr]
        inserts.insert([REPLICA_ID, ctr, parent[0], parent[1], ch])
        visibleTailRef.current = [...tail, id]
      }
      typedRef.current = next
    } else if (prev.startsWith(next)) {
      // Backspace at the end. Pop N from the visible tail and emit a
      // Remove op for each.
      const toDelete = prev.length - next.length
      for (let i = 0; i < toDelete; i++) {
        const id = visibleTailRef.current.pop()
        if (id) removes.insert([id[0], id[1]])
      }
      typedRef.current = next
    }
    // else: middle edits aren't supported. Let `useEffect` resnap the
    // textarea to the canonical CRDT view on the next render.
  }

  return (
    <div className="app">
      <header>
        <h1>flow-ts • collaborative text demo</h1>
        <p>
          Type into the box. Each keystroke fires an immutable{' '}
          <code>Insert(rep, ctr, parent_rep, parent_ctr, value)</code> op
          against the EDB; backspace fires a <code>Remove(rep, ctr)</code>.
          The rendered text comes from walking the derived{' '}
          <code>ListElem</code> linked list. Same Datalog as the bundled{' '}
          <code>examples/list_crdt.dl</code>, just hooked up to a textarea.
        </p>
      </header>

      <ProgramPanel />

      <section className="grid">
        <EditorPanel value={text.text} onChange={onChange} />
        <StatsPanel inserts={useLiveQuery(store, 'Insert')} removes={useLiveQuery(store, 'Remove')} elems={elems} />
      </section>

      <RelationInspector />
    </div>
  )
}

// --- panels ----------------------------------------------------------

function ProgramPanel() {
  return (
    <section className="program">
      <details data-testid="program-panel">
        <summary>Datalog program</summary>
        <pre data-testid="program-source"><code>{TEXT_SOURCE.trim()}</code></pre>
        <p className="muted">
          Two EDBs (<code>Insert</code>, <code>Remove</code>) and a dozen
          IDBs implementing a depth-first pre-order traversal of the
          insertion tree, skipping tombstoned nodes. Walking{' '}
          <code>ListElem</code> from <code>(0, 0)</code> reproduces the
          current text.
        </p>
      </details>
    </section>
  )
}

function EditorPanel({
  value,
  onChange,
}: {
  value: string
  onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void
}): JSX.Element {
  return (
    <div className="card">
      <div className="card-header">
        <h2>Editor</h2>
        <span className="muted text-hint">append / backspace only — no middle edits</span>
      </div>
      <textarea
        className="text-editor"
        data-testid="text-editor"
        value={value}
        onChange={onChange}
        spellCheck={false}
        rows={6}
        placeholder="start typing…"
      />
    </div>
  )
}

function StatsPanel({
  inserts,
  removes,
  elems,
}: {
  inserts: ReadonlyArray<InsertRow>
  removes: ReadonlyArray<RemoveRow>
  elems: ReadonlyArray<ListElemRow>
}): JSX.Element {
  return (
    <div className="card">
      <h2>Stats</h2>
      <ul className="stat-line">
        <li>
          <span data-testid="stat-inserts">{inserts.length}</span> inserts
        </li>
        <li>
          <span data-testid="stat-removes">{removes.length}</span> removes
        </li>
        <li>
          <span data-testid="stat-visible">{elems.length}</span> visible chars
        </li>
      </ul>
      <p className="muted">
        Every keystroke adds a row to <code>Insert</code> (or, for
        backspace, to <code>Remove</code>). Both are append-only — the
        full edit history stays in the EDB, and the visible text is the
        IDB projection.
      </p>
    </div>
  )
}

function RelationInspector() {
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
        The same generic <code>&lt;RelationTable&gt;</code> from the
        friend-graph demo. <code>Insert</code> and <code>Remove</code>{' '}
        are EDBs (add-row + delete buttons enabled); everything else is
        derived.
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
