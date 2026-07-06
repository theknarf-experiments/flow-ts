// Shared fact types and constants between client and server.

/** Relations the kanban demo synchronises. The server only relays
 *  these; the Datalog program (kanban.dl) lives on the clients and
 *  derives the `Display` / `DisplayCol` views from them. */
export const SYNCED_RELATIONS = [
  'Card',
  'CardText',
  'Move',
  'Delete',
  'Col',
  'ColName',
  'ColPos',
  'ColDelete',
] as const

/** Columns every fresh board is seeded with. The seed facts are
 *  deterministic (fixed ids 1..n, ts=0), so every replica writes the
 *  exact same rows and the sync layer dedups them — no coordination
 *  needed. ts=0 means any real user action (ts>0) wins over a seed. */
export const SEED_COLUMNS = ['todo', 'doing', 'done'] as const

/** Default port the WebTransport server listens on. */
export const SERVER_PORT = 4433

/** Default origin the client connects to. The cert's CommonName /
 *  SAN must include this hostname. */
export const SERVER_HOST = 'localhost'

/** WebTransport URL the client opens. */
export function serverUrl(host = SERVER_HOST, port = SERVER_PORT): string {
  return `https://${host}:${port}/sync`
}
