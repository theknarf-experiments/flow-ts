// Kanban sync hub. Listens for WebTransport sessions, attaches each
// one as a peer of a shared SyncEngine. The server runs no Datalog
// itself — its job is to be the always-on intermediary between
// browser clients, so two clients that don't have a direct path to
// each other (or aren't both online simultaneously) still
// converge via the server's MST.

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Http2Server } from '@fails-components/webtransport'
import { SyncEngine } from '@flow-ts/sync'
import { SERVER_HOST, SERVER_PORT, SYNCED_RELATIONS } from '../shared/facts.js'
import { bidiStreamTransport } from '../shared/transport.js'
import { loadOrGenerateCert } from './cert.js'

const HERE = dirname(fileURLToPath(import.meta.url))

async function main() {
  const cert = loadOrGenerateCert()
  console.log('[kanban] cert hash (SHA-256, base64):', cert.hashBase64)
  console.log('[kanban] cert hash (SHA-256, hex):   ', cert.hashHex)

  // Write the hash to a file the Vite client picks up — saves the
  // user from copy-pasting between terminals on every restart.
  writeFileSync(
    join(HERE, '..', '..', 'public', 'cert-hash.json'),
    JSON.stringify({ hashBase64: cert.hashBase64 }, null, 2),
  )

  const engine = new SyncEngine({
    replicaId: new Uint8Array([0]), // 0 = server
    relations: SYNCED_RELATIONS as unknown as string[],
  })

  // Server doesn't have a flow-ts session — no Datalog runs here.
  // We just observe what arrives so the operator can see activity.
  engine.onRemoteAdd((rel, row) => {
    console.log(`[kanban] ${rel}(${row.join(', ')})`)
  })

  // Http2Server uses WebTransport-over-HTTP/2 (via WebSocket
  // upgrade); the native http3-quiche binary requires GLIBC ≥ 2.38
  // which not every dev box has. The browser still talks to us
  // through the WebTransport JS API — it just falls back to the
  // polyfill (WebTransportPolyfill in `@fails-components/webtransport`),
  // which speaks the same WebSocket-based protocol underneath.
  const server = new Http2Server({
    port: SERVER_PORT,
    host: '0.0.0.0',
    secret: 'kanban-demo',
    cert: cert.cert,
    privKey: cert.privKey,
  })

  server.startServer()
  await server.ready
  console.log(`[kanban] listening on https://${SERVER_HOST}:${SERVER_PORT}/sync`)

  // Each WebTransport session that handshakes on /sync becomes one
  // attached peer on the engine. We then accept the first incoming
  // bidi stream from that session and wrap it as our Transport.
  const sessions = server.sessionStream('/sync')
  const sessionReader = sessions.getReader()
  while (true) {
    const { value: session, done } = await sessionReader.read()
    if (done) break
    if (!session) continue
    // Each new browser tab gets its own peer.
    attachClient(engine, session).catch((e) =>
      console.error('[kanban] client error', e),
    )
  }
}

async function attachClient(engine: SyncEngine, session: any): Promise<void> {
  await session.ready
  console.log('[kanban] client session ready')
  const reader = session.incomingBidirectionalStreams.getReader()
  const { value: bidi, done } = await reader.read()
  if (done || !bidi) {
    console.log('[kanban] client closed before opening a bidi stream')
    return
  }
  const transport = bidiStreamTransport(bidi)
  const peer = engine.attachPeer(transport)
  peer.synced.then(
    () => console.log('[kanban] client peer synced'),
    (e) => console.log('[kanban] client peer failed', e?.message),
  )
}

main().catch((e) => {
  console.error('[kanban] fatal', e)
  process.exit(1)
})
