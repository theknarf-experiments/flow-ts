// Shared fact types and constants between client and server.

/** Relations the kanban demo synchronises. The server only relays
 *  these; the Datalog program (kanban.dl) lives on the clients and
 *  derives `Display` from them. */
export const SYNCED_RELATIONS = ['Card', 'Move', 'Delete'] as const

/** The columns shown on the board. Renaming or extending these
 *  doesn't require any protocol change — Move's `col` field is a
 *  free-form string. */
export const COLUMNS = ['todo', 'doing', 'done'] as const
export type Column = (typeof COLUMNS)[number]

/** Default port the WebTransport server listens on. */
export const SERVER_PORT = 4433

/** Default origin the client connects to. The cert's CommonName /
 *  SAN must include this hostname. */
export const SERVER_HOST = 'localhost'

/** WebTransport URL the client opens. */
export function serverUrl(host = SERVER_HOST, port = SERVER_PORT): string {
  return `https://${host}:${port}/sync`
}
