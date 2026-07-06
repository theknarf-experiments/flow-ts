// Shared fact types and constants between client and server.

/** Relations the kanban demo synchronises. The server only relays
 *  these; the Datalog program (kanban.dl) lives on the clients and
 *  derives the `DisplayProject` / `DisplayCol` / `Display` views
 *  from them. */
export const SYNCED_RELATIONS = [
  'Project',
  'ProjectName',
  'Card',
  'CardText',
  'Move',
  'Delete',
  'Col',
  'ColName',
  'ColPos',
  'ColDelete',
] as const

/** The project every fresh board starts in. Its seed facts are
 *  deterministic (fixed uuid, ts=0), so every replica writes the
 *  exact same rows and the sync layer dedups them — no coordination
 *  needed. ts=0 means any real user action (ts>0) wins over a seed. */
export const DEFAULT_PROJECT_ID = '00000000-0000-0000-0000-000000000000'
export const DEFAULT_PROJECT_NAME = 'default'

/** Columns every project is created with. For the default project
 *  these use fixed ids 1..n (deterministic, deduped across replicas);
 *  for user-created projects they get random ids at creation time. */
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
