// End-to-end: two SyncEngines connected via a paired transport.
// Tests cover initial reconcile, live PUSH gossip, reconnect-from-
// scratch (transport drops, caller attaches a new transport), and a
// fast-check convergence property under interference.

import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import type { Row } from 'flow-ts'
import { SyncEngine } from '../../src/engine.js'
import { inMemoryPair, makeRng, withInterference } from '../../src/transport/index.js'
import { toHex } from '../../src/mst/index.js'

function newEngine(replica: number): { engine: SyncEngine; applied: Array<[string, Row]> } {
  const engine = new SyncEngine({
    replicaId: new Uint8Array([replica]),
    relations: ['R', 'S', 'Insert', 'Remove'],
  })
  const applied: Array<[string, Row]> = []
  engine.onRemoteAdd((rel, row) => applied.push([rel, row]))
  return { engine, applied }
}

describe('SyncEngine e2e', () => {
  it('converges two empty engines', async () => {
    const a = newEngine(1)
    const b = newEngine(2)
    const [ta, tb] = inMemoryPair()
    const pa = a.engine.attachPeer(ta)
    const pb = b.engine.attachPeer(tb)
    await Promise.all([pa.synced, pb.synced])
    expect(a.engine.size).toBe(0)
    expect(b.engine.size).toBe(0)
    pa.detach()
    pb.detach()
  })

  it('initial reconcile: A has facts, B catches up', async () => {
    const a = newEngine(1)
    const b = newEngine(2)
    a.engine.add('R', [1, 2])
    a.engine.add('R', [3, 4])
    a.engine.add('S', ['hello'])
    const [ta, tb] = inMemoryPair()
    const pa = a.engine.attachPeer(ta)
    const pb = b.engine.attachPeer(tb)
    await Promise.all([pa.synced, pb.synced])
    expect(b.engine.size).toBe(3)
    expect(b.applied.length).toBe(3)
    expect(toHex(a.engine.rootDigest())).toBe(toHex(b.engine.rootDigest()))
    pa.detach()
    pb.detach()
  })

  it('initial reconcile: both sides converge on disjoint facts', async () => {
    const a = newEngine(1)
    const b = newEngine(2)
    a.engine.add('R', [1, 2])
    a.engine.add('R', [3, 4])
    b.engine.add('R', [5, 6])
    b.engine.add('S', ['foo'])
    const [ta, tb] = inMemoryPair()
    const pa = a.engine.attachPeer(ta)
    const pb = b.engine.attachPeer(tb)
    await Promise.all([pa.synced, pb.synced])
    expect(a.engine.size).toBe(4)
    expect(b.engine.size).toBe(4)
    expect(toHex(a.engine.rootDigest())).toBe(toHex(b.engine.rootDigest()))
    pa.detach()
    pb.detach()
  })

  it('live PUSH: post-sync local writes gossip to the peer', async () => {
    const a = newEngine(1)
    const b = newEngine(2)
    const [ta, tb] = inMemoryPair()
    const pa = a.engine.attachPeer(ta)
    const pb = b.engine.attachPeer(tb)
    await Promise.all([pa.synced, pb.synced])
    // Both engines empty + synced. Now A writes; B should pick it up.
    a.engine.add('R', [42, 43])
    await new Promise((r) => setTimeout(r, 10))
    expect(b.engine.size).toBe(1)
    expect(b.applied.length).toBe(1)
    expect(b.applied[0]![0]).toBe('R')
    // And B → A too.
    b.engine.add('R', [99, 100])
    await new Promise((r) => setTimeout(r, 10))
    expect(a.engine.size).toBe(2)
    expect(a.applied.length).toBe(1)
    pa.detach()
    pb.detach()
  })

  it('reattach after detach: caught up via a fresh initial round', async () => {
    const a = newEngine(1)
    const b = newEngine(2)
    a.engine.add('R', [1])
    const [ta1, tb1] = inMemoryPair()
    const pa1 = a.engine.attachPeer(ta1)
    const pb1 = b.engine.attachPeer(tb1)
    await Promise.all([pa1.synced, pb1.synced])
    expect(b.engine.size).toBe(1)
    pa1.detach()
    pb1.detach()
    // A makes more progress while disconnected.
    a.engine.add('R', [2])
    a.engine.add('R', [3])
    // Reconnect via a new transport pair.
    const [ta2, tb2] = inMemoryPair()
    const pa2 = a.engine.attachPeer(ta2)
    const pb2 = b.engine.attachPeer(tb2)
    await Promise.all([pa2.synced, pb2.synced])
    expect(b.engine.size).toBe(3)
    pa2.detach()
    pb2.detach()
  })

  it('idempotent writes do not re-emit onRemoteAdd', async () => {
    const a = newEngine(1)
    const b = newEngine(2)
    const [ta, tb] = inMemoryPair()
    const pa = a.engine.attachPeer(ta)
    const pb = b.engine.attachPeer(tb)
    await Promise.all([pa.synced, pb.synced])
    a.engine.add('R', [7])
    await new Promise((r) => setTimeout(r, 10))
    expect(b.applied.length).toBe(1)
    // Add the same fact again — no remote callback.
    a.engine.add('R', [7])
    await new Promise((r) => setTimeout(r, 10))
    expect(b.applied.length).toBe(1)
    pa.detach()
    pb.detach()
  })

  it('converges under reorder + latency (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 0, max: 99 }), { minLength: 0, maxLength: 12 }),
        fc.uniqueArray(fc.integer({ min: 0, max: 99 }), { minLength: 0, maxLength: 12 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        async (aIds, bIds, seed) => {
          const a = newEngine(1)
          const b = newEngine(2)
          for (const i of aIds) a.engine.add('R', [i])
          for (const i of bIds) b.engine.add('R', [i])
          const [t1, t2] = inMemoryPair()
          const ta = withInterference(
            t1,
            { latencyMs: [1, 6], reorderProbability: 0.25 },
            makeRng(seed),
          )
          const tb = withInterference(
            t2,
            { latencyMs: [1, 6], reorderProbability: 0.25 },
            makeRng(seed ^ 0xfeed),
          )
          const pa = a.engine.attachPeer(ta)
          const pb = b.engine.attachPeer(tb)
          await Promise.all([pa.synced, pb.synced])
          const rootsMatch = toHex(a.engine.rootDigest()) === toHex(b.engine.rootDigest())
          pa.detach()
          pb.detach()
          return rootsMatch
        },
      ),
      { numRuns: 10 },
    )
  })
})
