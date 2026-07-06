// Kanban board. The board state lives in the Store's `Display` IDB,
// derived by the Datalog program from `Card`, `Move`, and `Delete`
// EDBs (kanban.dl). Local user actions write fresh facts to those
// EDBs via `Collection.insert`. A bridge keeps the EDBs synced to
// the server via @flow-ts/sync over WebTransport — every other
// connected browser gets the new facts via PUSH, and their Datalog
// program re-derives their own `Display` view.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Store, useLiveQuery } from '@flow-ts/react'
import type { Row } from 'flow-ts'
import { COLUMNS, SYNCED_RELATIONS, serverUrl, type Column } from '../shared/facts.js'
import { bidiStreamTransport } from '../shared/transport.js'
import { makeBridge } from './sync.js'
import { PROGRAM } from './program.js'

type DisplayRow = readonly [number, string, string] // [id, text, col]

/** Module-scope counters so cards added across multiple browser
 *  tabs/replicas don't collide on `id`. */
function newCardId(): number {
  return Math.floor(Math.random() * 1e15)
}

function newTs(): number {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000)
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
      </header>
      <p style={{ color: '#666', fontSize: 13 }}>
        Open this URL in another tab. Cards added or moved in one tab appear
        in the other through the server's MST. Drag-and-drop columns; the
        latest move wins via causal timestamp.
      </p>
      <Board store={store} />
    </div>
  )
}

function Board({ store }: { store: Store }) {
  const cards = useLiveQuery<DisplayRow>(store, 'Display')
  const grouped = useMemo(() => {
    const out: Record<Column, DisplayRow[]> = { todo: [], doing: [], done: [] }
    for (const row of cards) {
      const col = row[2] as Column
      if (col in out) out[col].push(row)
    }
    return out
  }, [cards])

  return (
    <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
      {COLUMNS.map((col) => (
        <ColumnView key={col} col={col} cards={grouped[col]} store={store} />
      ))}
    </div>
  )
}

function ColumnView({
  col,
  cards,
  store,
}: {
  col: Column
  cards: DisplayRow[]
  store: Store
}) {
  const [text, setText] = useState('')
  const [hover, setHover] = useState(false)

  function addCard() {
    if (!text.trim()) return
    const id = newCardId()
    const ts = newTs()
    store.update('Card', [id, text.trim()] as Row, +1)
    store.update('Move', [id, col, ts] as Row, +1)
    setText('')
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setHover(false)
    const id = Number(e.dataTransfer.getData('application/x-kanban-card'))
    if (!Number.isFinite(id)) return
    // Move = a fresh fact with the current ts. Last write wins.
    store.update('Move', [id, col, newTs()] as Row, +1)
  }

  return (
    <div
      data-col={col}
      onDragOver={(e) => {
        e.preventDefault()
        setHover(true)
      }}
      onDragLeave={() => setHover(false)}
      onDrop={onDrop}
      style={{
        flex: 1,
        background: hover ? '#eef6ff' : '#f5f5f5',
        border: '1px solid #ddd',
        borderRadius: 6,
        padding: 12,
        minHeight: 320,
      }}
    >
      <h2 style={{ marginTop: 0, fontSize: 16, textTransform: 'uppercase', color: '#555' }}>
        {col} <span style={{ color: '#999', fontSize: 12 }}>({cards.length})</span>
      </h2>
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
  const [id, text] = card
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
      <span style={{ flex: 1 }}>{text}</span>
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
