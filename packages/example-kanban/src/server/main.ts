// Kanban sync hub. Listens for WebTransport sessions, attaches each
// one as a peer of a shared SyncEngine. The server runs no Datalog
// itself — its job is to be the always-on intermediary between
// browser clients, so two clients that don't have a direct path to
// each other (or aren't both online simultaneously) still
// converge via the server's MST.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Http3Server, quicheLoaded } from '@fails-components/webtransport'
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
  const publicDir = join(HERE, '..', '..', 'public')
  mkdirSync(publicDir, { recursive: true })
  writeFileSync(
    join(publicDir, 'cert-hash.json'),
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

  // Native WebTransport over HTTP/3 (QUIC). This is required for
  // `serverCertificateHashes` to work: cert-hash pinning is a
  // WebTransport/QUIC feature, so the WebSocket-based HTTP/2
  // fallback would subject our self-signed cert to normal browser
  // TLS validation (and fail the handshake).
  await quicheLoaded
  const server = new Http3Server({
    port: SERVER_PORT,
    host: '::',
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
