// Bridge between the flow-ts Store (where the UI lives) and a
// @flow-ts/sync SyncEngine (which talks to the server over
// WebTransport). The bridge wires the two engines together so:
//
//   * Every fact the local user adds to a synced relation in the
//     Store gets forwarded to the engine (and from there pushed
//     to every connected peer).
//   * Every fact the engine learns about from a peer gets applied
//     to the Store, which fires its own subscribers and re-renders.
//
// Both sides are idempotent — duplicate insertions are dropped
// by the Store's row-key dedup AND by the engine's MST — so the
// "echo" path (local insert → engine.add → engine ignored
// because we already have it; later peer push → onRemoteFact →
// Store.update → subscriber → engine.add → engine ignored again)
// is safe.

import { encodeRow, type Row } from 'flow-ts'
import type { Store } from '@flow-ts/react'
import { SyncEngine, type Transport, type Unsubscribe } from '@flow-ts/sync'

export interface BridgeOptions {
  store: Store
  replicaId: Uint8Array
  relations: readonly string[]
}

export interface Bridge {
  engine: SyncEngine
  attach(transport: Transport): { synced: Promise<void>; detach: () => void }
  dispose(): void
}

export function makeBridge(opts: BridgeOptions): Bridge {
  const engine = new SyncEngine({
    replicaId: opts.replicaId,
    relations: opts.relations,
  })

  // Track facts we've already mirrored from the Store into the
  // engine, so the Store-change subscription doesn't repeatedly
  // call engine.add for unchanged rows.
  const mirrored = new Set<string>()
  const factKey = (rel: string, row: Row): string => `${rel}|${encodeRow(row)}`

  const unsubStore: Unsubscribe[] = []
  for (const rel of opts.relations) {
    // Seed with whatever the Store already has at attach time.
    for (const row of opts.store.snapshot(rel)) {
      const k = factKey(rel, row)
      if (mirrored.has(k)) continue
      mirrored.add(k)
      engine.add(rel, row)
    }
    // Then watch for new arrivals.
    const u = opts.store.subscribe(rel, () => {
      for (const row of opts.store.snapshot(rel)) {
        const k = factKey(rel, row)
        if (mirrored.has(k)) continue
        mirrored.add(k)
        engine.add(rel, row)
      }
    })
    unsubStore.push(u)
  }

  // Apply remote facts to the Store. The Store.update path is
  // idempotent, so a duplicate from PUSH (which we may already have
  // had locally) is silently dropped.
  const unsubEngine = engine.onRemoteAdd((rel, row) => {
    if (!opts.relations.includes(rel)) return
    const k = factKey(rel, row)
    if (mirrored.has(k)) return
    mirrored.add(k)
    opts.store.update(rel, row, +1)
  })

  return {
    engine,
    attach(transport) {
      const peer = engine.attachPeer(transport)
      return peer
    },
    dispose() {
      for (const u of unsubStore) u()
      unsubEngine()
    },
  }
}
