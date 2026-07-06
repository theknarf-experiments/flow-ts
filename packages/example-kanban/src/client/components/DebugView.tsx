// Raw-data debug view: one Tanstack table per relation in the Datalog
// program, straight from the Store with no project filtering. EDBs are
// the append-only CRDT facts (all of them synced through the server in
// this demo — the badge reads from SYNCED_RELATIONS, not from the EDB/
// IDB split, so a hypothetical local-only EDB would show correctly);
// IDBs are the views the program derives locally and are never synced.
//
// EDB tables include the RelationTable add-row, so raw facts can be
// injected here for debugging — they flow through the sync bridge
// exactly like board actions do.

import { Store } from '@flow-ts/react'
import { SYNCED_RELATIONS } from '../../shared/facts.js'
import { PROGRAM } from '../program.js'
import { RelationTable } from './RelationTable.js'

const SYNCED = new Set<string>(SYNCED_RELATIONS)

export function DebugView({ store }: { store: Store }) {
  return (
    <div style={{ marginTop: 16 }}>
      <Section
        title="input facts (EDBs)"
        hint="append-only CRDT facts — the synced ones are relayed through the server's MST"
        relations={PROGRAM.edbs.map((d) => d.name)}
        store={store}
      />
      <Section
        title="derived views (IDBs)"
        hint="computed locally by the Datalog program from the facts above — never synced"
        relations={PROGRAM.idbs.map((d) => d.name)}
        store={store}
      />
    </div>
  )
}

function Section({
  title,
  hint,
  relations,
  store,
}: {
  title: string
  hint: string
  relations: string[]
  store: Store
}) {
  return (
    <section style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 16, color: '#555', marginBottom: 2 }}>{title}</h2>
      <p style={{ color: '#888', fontSize: 13, marginTop: 0 }}>{hint}</p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))',
          gap: 16,
          alignItems: 'start',
        }}
      >
        {relations.map((rel) => (
          <RelationTable
            key={rel}
            store={store}
            program={PROGRAM}
            relation={rel}
            badge={<SyncBadge relation={rel} />}
          />
        ))}
      </div>
    </section>
  )
}

function SyncBadge({ relation }: { relation: string }) {
  const synced = SYNCED.has(relation)
  return (
    <span
      data-testid={`relation-sync-${relation}`}
      style={{
        fontSize: 11,
        padding: '1px 8px',
        borderRadius: 999,
        background: synced ? '#e0f5ec' : '#eee',
        color: synced ? '#177a52' : '#777',
        border: `1px solid ${synced ? '#9fd8c0' : '#ddd'}`,
      }}
    >
      {synced ? 'synced' : 'local'}
    </span>
  )
}
