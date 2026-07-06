// Kanban board. The board view lives in the Store's `DisplayProject`,
// `DisplayCol` and `Display` IDBs, derived by the Datalog program
// (kanban.dl) from append-only CRDT facts. Local user actions only
// ever *add* facts: renames, moves and reorders are new facts with
// fresh timestamps (last writer wins), deletes are tombstones. A
// bridge keeps the EDBs synced to the server via @flow-ts/sync over
// WebTransport — every other connected browser gets the new facts via
// PUSH, and their Datalog program re-derives their own views.
//
// Everything belongs to a project: columns and cards carry the uuid
// of the project they were created in, and the board only renders the
// currently selected project. Which project is selected is local UI
// state — it is not synced.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Store, useLiveQuery } from '@flow-ts/react'
import type { Row } from 'flow-ts'
import {
  DEFAULT_PROJECT_ID,
  DEFAULT_PROJECT_NAME,
  SEED_COLUMNS,
  SYNCED_RELATIONS,
  serverUrl,
} from '../shared/facts.js'
import { bidiStreamTransport } from '../shared/transport.js'
import { makeBridge } from './sync.js'
import { PROGRAM } from './program.js'
import { DebugView } from './components/DebugView.js'

type ProjectRow = readonly [string, string] // [pid, name]
type ColRow = readonly [number, string, string, number] // [id, project, name, pos]
type DisplayRow = readonly [number, string, string, number] // [id, project, text, colId]

/** Module-scope random ids so entities created across multiple
 *  browser tabs/replicas don't collide. */
function newId(): number {
  return Math.floor(Math.random() * 1e15)
}

function newTs(): number {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000)
}

/** Deterministic seed facts: identical rows on every replica, so the
 *  sync layer dedups them into a single set. Seeds use ts=0, letting
 *  any real user action (rename, reorder, delete) win permanently. */
function seedDefaults(store: Store): void {
  store.update('Project', [DEFAULT_PROJECT_ID] as Row, +1)
  store.update('ProjectName', [DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME, 0] as Row, +1)
  SEED_COLUMNS.forEach((name, i) => {
    const id = i + 1
    store.update('Col', [id, DEFAULT_PROJECT_ID] as Row, +1)
    store.update('ColName', [id, name, 0] as Row, +1)
    store.update('ColPos', [id, (i + 1) * 1024, 0] as Row, +1)
  })
}

export function App() {
  // Single Store / SyncEngine per page load. React StrictMode would
  // double-invoke effects so we guard with a ref.
  const initRef = useRef<{
    store: Store
    engine: ReturnType<typeof makeBridge>['engine']
  } | null>(null)
  if (!initRef.current) {
    const store = new Store(PROGRAM)
    seedDefaults(store)
    const bridge = makeBridge({
      store,
      replicaId: new Uint8Array([Math.floor(Math.random() * 255)]),
      relations: SYNCED_RELATIONS as unknown as string[],
    })
    initRef.current = { store, engine: bridge.engine }
    void connect(bridge.attach)
  }
  const { store } = initRef.current
  const [status, setStatus] = useState<'connecting' | 'synced' | 'offline'>('connecting')
  const [projectId, setProjectId] = useState<string>(DEFAULT_PROJECT_ID)
  const [view, setView] = useState<'board' | 'data'>('board')

  // Listen for sync status — the bridge exposes a promise on the
  // first attach; we recompute on (re)connect.
  useEffect(() => {
    // The connect() helper above sets the status via a custom event
    // dispatched on window. Avoids passing a setter through closures.
    function onStatus(e: Event) {
      const { detail } = e as CustomEvent<typeof status>
      setStatus(detail)
    }
    window.addEventListener('kanban:status', onStatus)
    return () => window.removeEventListener('kanban:status', onStatus)
  }, [])

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 16 }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <h1 style={{ margin: 0 }}>flow-ts kanban</h1>
        <span data-testid="sync-status" style={{ color: statusColour(status), fontSize: 13 }}>
          {statusLabel(status)}
        </span>
        <span style={{ flex: 1 }} />
        <ViewTab label="board" active={view === 'board'} onClick={() => setView('board')} />
        <ViewTab label="data" active={view === 'data'} onClick={() => setView('data')} />
      </header>
      {view === 'board' ? (
        <>
          <p style={{ color: '#666', fontSize: 13 }}>
            Open this URL in another tab. Projects, cards and columns added,
            renamed, reordered or deleted in one tab appear in the other
            through the server's MST — the latest edit wins via causal
            timestamp. Double-click a project, column or card name to rename
            it.
          </p>
          <ProjectBar store={store} projectId={projectId} onSelect={setProjectId} />
          <Board store={store} projectId={projectId} />
        </>
      ) : (
        <DebugView store={store} />
      )}
    </div>
  )
}

function ViewTab({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      data-testid={`view-${label}`}
      onClick={onClick}
      style={{
        padding: '4px 12px',
        borderRadius: 4,
        border: '1px solid #ccc',
        background: active ? '#555' : '#f5f5f5',
        color: active ? '#fff' : '#555',
        cursor: 'pointer',
        fontSize: 13,
      }}
    >
      {label}
    </button>
  )
}

function ProjectBar({
  store,
  projectId,
  onSelect,
}: {
  store: Store
  projectId: string
  onSelect: (pid: string) => void
}) {
  const rows = useLiveQuery<ProjectRow>(store, 'DisplayProject')
  const [newName, setNewName] = useState('')

  const projects = useMemo(() => {
    const s = [...rows].sort(
      (a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : 1),
    )
    // A same-ts rename conflict can briefly surface two names for one
    // project id; render one of them deterministically.
    const seen = new Set<string>()
    return s.filter((p) => (seen.has(p[0]) ? false : (seen.add(p[0]), true)))
  }, [rows])

  const currentName = projects.find((p) => p[0] === projectId)?.[1] ?? ''

  function addProject() {
    const name = newName.trim()
    if (!name) return
    const pid = crypto.randomUUID()
    const ts = newTs()
    store.update('Project', [pid] as Row, +1)
    store.update('ProjectName', [pid, name, ts] as Row, +1)
    // Every project starts with the default columns. Random ids —
    // unlike the default project's seeds, this runs once, on the
    // creating replica only.
    SEED_COLUMNS.forEach((cname, i) => {
      const cid = newId()
      store.update('Col', [cid, pid] as Row, +1)
      store.update('ColName', [cid, cname, ts] as Row, +1)
      store.update('ColPos', [cid, (i + 1) * 1024, ts] as Row, +1)
    })
    setNewName('')
    onSelect(pid)
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
      <label htmlFor="project-select" style={{ fontSize: 13, color: '#555' }}>
        project:
      </label>
      <select
        id="project-select"
        data-testid="project-select"
        value={projectId}
        onChange={(e) => onSelect(e.target.value)}
        style={{ padding: 4, borderRadius: 4 }}
      >
        {projects.map(([pid, name]) => (
          <option key={pid} value={pid}>
            {name}
          </option>
        ))}
      </select>
      <EditableLabel
        value={currentName}
        onCommit={(next) => store.update('ProjectName', [projectId, next, newTs()] as Row, +1)}
        displayTestId="project-name"
        inputTestId="project-rename"
        style={{ fontSize: 13, color: '#555' }}
      />
      <span style={{ flex: 1 }} />
      <input
        data-testid="new-project"
        value={newName}
        onChange={(e) => setNewName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && addProject()}
        placeholder="new project…"
        style={{ padding: 6, border: '1px solid #ccc', borderRadius: 4 }}
      />
      <button
        data-testid="add-project"
        onClick={addProject}
        style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid #ccc' }}
      >
        add project
      </button>
    </div>
  )
}

function Board({ store, projectId }: { store: Store; projectId: string }) {
  const cards = useLiveQuery<DisplayRow>(store, 'Display')
  const cols = useLiveQuery<ColRow>(store, 'DisplayCol')

  const sorted = useMemo(() => {
    const s = cols
      .filter((c) => c[1] === projectId)
      .sort((a, b) => a[3] - b[3] || a[0] - b[0] || (a[2] < b[2] ? -1 : 1))
    // A same-ts rename conflict can briefly surface two names for one
    // column id; render one of them deterministically.
    const seen = new Set<number>()
    return s.filter((c) => (seen.has(c[0]) ? false : (seen.add(c[0]), true)))
  }, [cols, projectId])

  const grouped = useMemo(() => {
    const out = new Map<number, DisplayRow[]>()
    for (const row of cards) {
      if (row[1] !== projectId) continue
      const list = out.get(row[3]) ?? []
      list.push(row)
      out.set(row[3], list)
    }
    return out
  }, [cards, projectId])

  // Reorder = the two columns trade positions under a fresh ts.
  function swapCols(a: ColRow, b: ColRow): void {
    const ts = newTs()
    store.update('ColPos', [a[0], b[3], ts] as Row, +1)
    store.update('ColPos', [b[0], a[3], ts] as Row, +1)
  }

  return (
    <div style={{ display: 'flex', gap: 12, marginTop: 16, alignItems: 'flex-start' }}>
      {sorted.map((c, i) => (
        <ColumnView
          key={c[0]}
          col={c}
          cards={grouped.get(c[0]) ?? []}
          store={store}
          projectId={projectId}
          onMoveLeft={i > 0 ? () => swapCols(c, sorted[i - 1]!) : undefined}
          onMoveRight={i < sorted.length - 1 ? () => swapCols(c, sorted[i + 1]!) : undefined}
        />
      ))}
      <AddColumn
        store={store}
        projectId={projectId}
        nextPos={(sorted[sorted.length - 1]?.[3] ?? 0) + 1024}
      />
    </div>
  )
}

function AddColumn({
  store,
  projectId,
  nextPos,
}: {
  store: Store
  projectId: string
  nextPos: number
}) {
  const [name, setName] = useState('')
  function add() {
    const trimmed = name.trim()
    if (!trimmed) return
    const id = newId()
    const ts = newTs()
    store.update('Col', [id, projectId] as Row, +1)
    store.update('ColName', [id, trimmed, ts] as Row, +1)
    store.update('ColPos', [id, nextPos, ts] as Row, +1)
    setName('')
  }
  return (
    <div style={{ minWidth: 200, display: 'flex', gap: 4 }}>
      <input
        data-testid="new-column"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && add()}
        placeholder="new column…"
        style={{ flex: 1, padding: 6, border: '1px solid #ccc', borderRadius: 4 }}
      />
      <button
        data-testid="add-column"
        onClick={add}
        style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid #ccc' }}
      >
        add
      </button>
    </div>
  )
}

/** Inline-editable text: double-click to edit, Enter commits,
 *  Escape/blur cancels. */
function EditableLabel({
  value,
  onCommit,
  displayTestId,
  inputTestId,
  style,
}: {
  value: string
  onCommit: (next: string) => void
  displayTestId: string
  inputTestId: string
  style?: React.CSSProperties
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  if (!editing) {
    return (
      <span
        data-testid={displayTestId}
        title="double-click to rename"
        onDoubleClick={() => {
          setDraft(value)
          setEditing(true)
        }}
        style={{ cursor: 'text', ...style }}
      >
        {value}
      </span>
    )
  }
  return (
    <input
      data-testid={inputTestId}
      value={draft}
      autoFocus
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => setEditing(false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          const next = draft.trim()
          if (next && next !== value) onCommit(next)
          setEditing(false)
        } else if (e.key === 'Escape') {
          setEditing(false)
        }
      }}
      style={{ padding: 2, border: '1px solid #88c', borderRadius: 3, ...style }}
    />
  )
}

function ColumnView({
  col,
  cards,
  store,
  projectId,
  onMoveLeft,
  onMoveRight,
}: {
  col: ColRow
  cards: DisplayRow[]
  store: Store
  projectId: string
  onMoveLeft?: (() => void) | undefined
  onMoveRight?: (() => void) | undefined
}) {
  const [colId, , name] = col
  const [text, setText] = useState('')
  const [hover, setHover] = useState(false)

  function addCard() {
    const trimmed = text.trim()
    if (!trimmed) return
    const id = newId()
    const ts = newTs()
    store.update('Card', [id, projectId] as Row, +1)
    store.update('CardText', [id, trimmed, ts] as Row, +1)
    store.update('Move', [id, colId, ts] as Row, +1)
    setText('')
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setHover(false)
    const id = Number(e.dataTransfer.getData('application/x-kanban-card'))
    if (!Number.isFinite(id)) return
    // Move = a fresh fact with the current ts. Last write wins.
    store.update('Move', [id, colId, newTs()] as Row, +1)
  }

  const headerBtn: React.CSSProperties = {
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    color: '#999',
    padding: '0 2px',
  }

  return (
    <div
      data-col={colId}
      data-col-name={name}
      onDragOver={(e) => {
        e.preventDefault()
        setHover(true)
      }}
      onDragLeave={() => setHover(false)}
      onDrop={onDrop}
      style={{
        flex: 1,
        minWidth: 180,
        background: hover ? '#eef6ff' : '#f5f5f5',
        border: '1px solid #ddd',
        borderRadius: 6,
        padding: 12,
        minHeight: 320,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 16, color: '#555', flex: 1, fontWeight: 600 }}>
          <EditableLabel
            value={name}
            onCommit={(next) => store.update('ColName', [colId, next, newTs()] as Row, +1)}
            displayTestId="col-name"
            inputTestId="col-rename"
          />{' '}
          <span style={{ color: '#999', fontSize: 12 }}>({cards.length})</span>
        </h2>
        <button data-testid="col-left" title="move column left" disabled={!onMoveLeft} onClick={onMoveLeft} style={headerBtn}>
          ◀
        </button>
        <button data-testid="col-right" title="move column right" disabled={!onMoveRight} onClick={onMoveRight} style={headerBtn}>
          ▶
        </button>
        <button
          data-testid="col-delete"
          title="delete column"
          onClick={() => store.update('ColDelete', [colId] as Row, +1)}
          style={headerBtn}
        >
          ×
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {cards.map((c) => (
          <Card key={c[0]} card={c} store={store} />
        ))}
      </div>
      <div style={{ marginTop: 12, display: 'flex', gap: 4 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addCard()}
          placeholder="new card…"
          style={{ flex: 1, padding: 6, border: '1px solid #ccc', borderRadius: 4 }}
        />
        <button
          onClick={addCard}
          style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid #ccc' }}
        >
          add
        </button>
      </div>
    </div>
  )
}

function Card({ card, store }: { card: DisplayRow; store: Store }) {
  const [id, , text] = card
  function onDragStart(e: React.DragEvent) {
    e.dataTransfer.setData('application/x-kanban-card', String(id))
    e.dataTransfer.effectAllowed = 'move'
  }
  function onDelete() {
    store.update('Delete', [id] as Row, +1)
  }
  return (
    <div
      draggable
      onDragStart={onDragStart}
      style={{
        background: '#fff',
        border: '1px solid #ddd',
        borderRadius: 4,
        padding: 8,
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        cursor: 'grab',
      }}
    >
      <EditableLabel
        value={text}
        onCommit={(next) => store.update('CardText', [id, next, newTs()] as Row, +1)}
        displayTestId="card-text"
        inputTestId="card-rename"
        style={{ flex: 1 }}
      />
      <button
        onClick={onDelete}
        title="delete"
        style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#999' }}
      >
        ×
      </button>
    </div>
  )
}

function statusLabel(s: 'connecting' | 'synced' | 'offline'): string {
  return s === 'connecting' ? '⏳ connecting…' : s === 'synced' ? '✓ synced' : '⚠ offline'
}
function statusColour(s: 'connecting' | 'synced' | 'offline'): string {
  return s === 'connecting' ? '#888' : s === 'synced' ? '#2a8' : '#c44'
}

async function connect(attach: (t: import('@flow-ts/sync').Transport) => {
  synced: Promise<void>
  detach: () => void
}): Promise<void> {
  // Pull the cert hash the server printed at startup. The Vite dev
  // server serves files under /public, so the cert-hash.json the
  // backend writes is reachable at /cert-hash.json.
  let hashBase64: string
  try {
    const r = await fetch('/cert-hash.json')
    hashBase64 = (await r.json()).hashBase64
  } catch {
    console.warn('[kanban] no cert-hash.json — is the server running?')
    window.dispatchEvent(new CustomEvent('kanban:status', { detail: 'offline' }))
    return
  }
  // SHA-256, base64 → Uint8Array.
  const hashBytes = Uint8Array.from(atob(hashBase64), (c) => c.charCodeAt(0))

  // Native WebTransport (HTTP/3) is required for cert-hash pinning:
  // `serverCertificateHashes` only bypasses CA validation on QUIC.
  // We deliberately don't fall back to the ponyfill from
  // `@fails-components/webtransport`: its WebSocket transport goes
  // through normal TLS validation (which rejects our self-signed
  // cert), and merely importing the module fires a feature-detection
  // probe to a dummy https://example.com URL that pollutes the
  // console with a QUIC error.
  if (!('WebTransport' in globalThis)) {
    console.error(
      '[kanban] this browser has no native WebTransport — use Chrome or Edge.',
    )
    window.dispatchEvent(new CustomEvent('kanban:status', { detail: 'offline' }))
    return
  }
  const wt = new WebTransport(serverUrl(), {
    serverCertificateHashes: [{ algorithm: 'sha-256', value: hashBytes }],
  })
  try {
    await wt.ready
  } catch (e) {
    console.error('[kanban] WebTransport open failed', e)
    window.dispatchEvent(new CustomEvent('kanban:status', { detail: 'offline' }))
    return
  }
  const bidi = await wt.createBidirectionalStream()
  const transport = bidiStreamTransport(bidi)
  const peer = attach(transport)
  peer.synced.then(
    () => {
      console.log('[kanban] synced with server')
      window.dispatchEvent(new CustomEvent('kanban:status', { detail: 'synced' }))
    },
    (e) => {
      console.error('[kanban] sync failed', e)
      window.dispatchEvent(new CustomEvent('kanban:status', { detail: 'offline' }))
    },
  )
}
