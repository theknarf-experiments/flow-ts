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

  it('local-superset: over-fetches peer keys but converges idempotently', async () => {
    // From the Quint spec's v2 (mst-diff.qnt) finding: when local is a
    // superset of peer, the page-range diff still flags differing
    // pages as inconsistent (their start/end/hash differ because
    // local's pages cover more keys). Local FETCHes back keys it
    // already has; the apply step is idempotent so the round
    // converges cleanly. Verifies that this case doesn't deadlock,
    // duplicate-emit, or otherwise misbehave.
    const a = newEngine(1)
    const b = newEngine(2)
    // A has a superset of B's facts.
    a.engine.add('R', [1])
    a.engine.add('R', [2])
    a.engine.add('R', [3])
    a.engine.add('R', [4])
    a.engine.add('R', [5])
    b.engine.add('R', [3]) // B has only one of A's keys.
    const [ta, tb] = inMemoryPair()
    const pa = a.engine.attachPeer(ta)
    const pb = b.engine.attachPeer(tb)
    await Promise.all([pa.synced, pb.synced])
    expect(a.engine.size).toBe(5)
    expect(b.engine.size).toBe(5)
    expect(toHex(a.engine.rootDigest())).toBe(toHex(b.engine.rootDigest()))
    // A had no facts to learn from B — onRemoteAdd may have fired
    // for B's "3" (the over-fetch) but the row was already present,
    // so the engine's internal dedup means our applied callback
    // should not have re-fired for it.
    const dedupedA = new Set(a.applied.map(([rel, row]) => `${rel}|${row.join(',')}`))
    expect(dedupedA.size).toBe(a.applied.length) // no duplicates emitted
    pa.detach()
    pb.detach()
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

  it('multi-peer fan-out: A pushes one fact to both B and C', async () => {
    const a = newEngine(1)
    const b = newEngine(2)
    const c = newEngine(3)
    const [tab, tba] = inMemoryPair()
    const [tac, tca] = inMemoryPair()
    const pab = a.engine.attachPeer(tab)
    const pba = b.engine.attachPeer(tba)
    const pac = a.engine.attachPeer(tac)
    const pca = c.engine.attachPeer(tca)
    await Promise.all([pab.synced, pba.synced, pac.synced, pca.synced])
    // A writes one fact post-sync; expect PUSH to fan out to both B and C.
    a.engine.add('R', [42])
    await new Promise((r) => setTimeout(r, 20))
    expect(b.engine.size).toBe(1)
    expect(c.engine.size).toBe(1)
    expect(toHex(a.engine.rootDigest())).toBe(toHex(b.engine.rootDigest()))
    expect(toHex(a.engine.rootDigest())).toBe(toHex(c.engine.rootDigest()))
    pab.detach()
    pba.detach()
    pac.detach()
    pca.detach()
  })

  it('add() called during initial round: new fact reaches peer in same session', async () => {
    const a = newEngine(1)
    const b = newEngine(2)
    a.engine.add('R', [1])
    // Slow down the transport so the initial round is mid-way when
    // we call add(). The new fact should still make it across — either
    // included in A's PAGE_RANGES (if computed late enough) or via
    // the live-PUSH path once A's round completes.
    const [t1, t2] = inMemoryPair()
    const ta = withInterference(t1, { latencyMs: [5, 10] }, makeRng(1))
    const tb = withInterference(t2, { latencyMs: [5, 10] }, makeRng(2))
    const pa = a.engine.attachPeer(ta)
    const pb = b.engine.attachPeer(tb)
    // Race add() against the round.
    a.engine.add('R', [2])
    a.engine.add('R', [3])
    await Promise.all([pa.synced, pb.synced])
    // After sync + any post-round PUSH propagation:
    await new Promise((r) => setTimeout(r, 50))
    expect(b.engine.size).toBe(3)
    expect(toHex(a.engine.rootDigest())).toBe(toHex(b.engine.rootDigest()))
    pa.detach()
    pb.detach()
  })

  it("peer's mid-round write is caught on a subsequent reconnect", async () => {
    const a = newEngine(1)
    const b = newEngine(2)
    a.engine.add('R', [1])
    const [t1, t2] = inMemoryPair()
    const pa1 = a.engine.attachPeer(t1)
    const pb1 = b.engine.attachPeer(t2)
    await Promise.all([pa1.synced, pb1.synced])
    expect(b.engine.size).toBe(1)
    // While disconnected, B writes new fact.
    pa1.detach()
    pb1.detach()
    b.engine.add('R', [99])
    // Reconnect — A should pick up B's new fact via the root-digest mismatch.
    const [t3, t4] = inMemoryPair()
    const pa2 = a.engine.attachPeer(t3)
    const pb2 = b.engine.attachPeer(t4)
    await Promise.all([pa2.synced, pb2.synced])
    expect(a.engine.size).toBe(2)
    expect(b.engine.size).toBe(2)
    expect(toHex(a.engine.rootDigest())).toBe(toHex(b.engine.rootDigest()))
    pa2.detach()
    pb2.detach()
  })

  it('listener exception does not break the engine or block subsequent listeners', async () => {
    const a = newEngine(1)
    const b = newEngine(2)
    let goodCalls = 0
    a.engine.onRemoteAdd(() => {
      throw new Error('user listener buggy')
    })
    a.engine.onRemoteAdd(() => {
      goodCalls++
    })
    b.engine.add('R', [1])
    const [ta, tb] = inMemoryPair()
    const pa = a.engine.attachPeer(ta)
    const pb = b.engine.attachPeer(tb)
    await Promise.all([pa.synced, pb.synced])
    expect(a.engine.size).toBe(1)
    expect(goodCalls).toBeGreaterThanOrEqual(1) // second listener still fired
    pa.detach()
    pb.detach()
  })

  it('detach while PUSH is in-flight: no crash, peer cleanly disconnects', async () => {
    const a = newEngine(1)
    const b = newEngine(2)
    const [ta, tb] = inMemoryPair()
    const pa = a.engine.attachPeer(ta)
    const pb = b.engine.attachPeer(tb)
    await Promise.all([pa.synced, pb.synced])
    // Burst of writes — multiple PUSHes will be in flight.
    for (let i = 0; i < 20; i++) a.engine.add('R', [i])
    // Detach A immediately (mid-burst).
    pa.detach()
    // Drain microtasks. B may or may not have received some of the
    // PUSHes — both outcomes are acceptable; the must-not is "crash".
    await new Promise((r) => setTimeout(r, 10))
    expect(b.engine.size).toBeGreaterThanOrEqual(0)
    expect(b.engine.size).toBeLessThanOrEqual(20)
    pb.detach()
  })

  it('add() before attachPeer is included in the initial round', async () => {
    const a = newEngine(1)
    const b = newEngine(2)
    a.engine.add('R', [1])
    a.engine.add('R', [2])
    // Note: attachPeer happens AFTER both adds. The session must
    // serialise A's full state in its initial PAGE_RANGES.
    const [ta, tb] = inMemoryPair()
    const pa = a.engine.attachPeer(ta)
    const pb = b.engine.attachPeer(tb)
    await Promise.all([pa.synced, pb.synced])
    expect(b.engine.size).toBe(2)
    pa.detach()
    pb.detach()
  })

  it('mid-round write on peer side: new fact reaches local in same session via PAGE_RANGES retry', async () => {
    // Race condition the v2 Quint spec flagged: B adds a fact AFTER
    // its initial PAGE_RANGES was sent but BEFORE the round completes.
    // B's pump should retry PAGE_RANGES with the updated set; A
    // should pick it up and re-FETCH.
    const a = newEngine(1)
    const b = newEngine(2)
    b.engine.add('R', [1])
    b.engine.add('R', [2])
    // Slow transport so the round is in flight long enough for the
    // mid-round write to land.
    const [t1, t2] = inMemoryPair()
    const ta = withInterference(t1, { latencyMs: [10, 25] }, makeRng(11))
    const tb = withInterference(t2, { latencyMs: [10, 25] }, makeRng(12))
    const pa = a.engine.attachPeer(ta)
    const pb = b.engine.attachPeer(tb)
    // Add a fact on B while A's round is still mid-flight.
    setTimeout(() => b.engine.add('R', [99]), 5)
    await Promise.all([pa.synced, pb.synced])
    // Even after both promises resolve, A's session may still be
    // in the middle of catching up via PAGE_RANGES retries. Give it
    // a window.
    await new Promise((r) => setTimeout(r, 200))
    expect(a.engine.size).toBe(3)
    expect(b.engine.size).toBe(3)
    expect(toHex(a.engine.rootDigest())).toBe(toHex(b.engine.rootDigest()))
    pa.detach()
    pb.detach()
  })

  it('large burst of writes pre-sync: all included in PAGE_RANGES', async () => {
    const a = newEngine(1)
    const b = newEngine(2)
    for (let i = 0; i < 200; i++) a.engine.add('R', [i])
    const [ta, tb] = inMemoryPair()
    const pa = a.engine.attachPeer(ta)
    const pb = b.engine.attachPeer(tb)
    await Promise.all([pa.synced, pb.synced])
    expect(b.engine.size).toBe(200)
    expect(toHex(a.engine.rootDigest())).toBe(toHex(b.engine.rootDigest()))
    pa.detach()
    pb.detach()
  })

  it('multi-peer + writes + drops: stress (3 replicas)', async () => {
    // Three replicas A, B, C, each connected to the other two via
    // independent transports. Mid-round writes on every replica;
    // 25% packet drop on every link. End state: all three converged.
    const retry = { intervalMs: 30, maxAttempts: 40 }
    const a = new SyncEngine({ replicaId: new Uint8Array([1]), relations: ['R'] })
    const b = new SyncEngine({ replicaId: new Uint8Array([2]), relations: ['R'] })
    const c = new SyncEngine({ replicaId: new Uint8Array([3]), relations: ['R'] })
    a.add('R', [1])
    a.add('R', [2])
    b.add('R', [3])
    c.add('R', [4])
    c.add('R', [5])
    function wrap(t: ReturnType<typeof inMemoryPair>[0], seed: number) {
      return withInterference(t, { dropProbability: 0.25 }, makeRng(seed))
    }
    const [tab, tba] = inMemoryPair()
    const [tac, tca] = inMemoryPair()
    const [tbc, tcb] = inMemoryPair()
    const handles = [
      a.attachPeer(wrap(tab, 1), { retry }),
      b.attachPeer(wrap(tba, 2), { retry }),
      a.attachPeer(wrap(tac, 3), { retry }),
      c.attachPeer(wrap(tca, 4), { retry }),
      b.attachPeer(wrap(tbc, 5), { retry }),
      c.attachPeer(wrap(tcb, 6), { retry }),
    ]
    await Promise.all(handles.map((h) => h.synced))
    // Mid-round-ish writes (already past initial sync — exercise PUSH).
    for (let i = 10; i < 20; i++) a.add('R', [i])
    for (let i = 20; i < 30; i++) b.add('R', [i])
    for (let i = 30; i < 40; i++) c.add('R', [i])
    // Wait for PUSH propagation across all peers.
    await new Promise((r) => setTimeout(r, 3000))
    const expected = 5 + 30 // initial 5 unique + 30 mid-round
    expect(a.size).toBe(expected)
    expect(b.size).toBe(expected)
    expect(c.size).toBe(expected)
    expect(toHex(a.rootDigest())).toBe(toHex(b.rootDigest()))
    expect(toHex(b.rootDigest())).toBe(toHex(c.rootDigest()))
    handles.forEach((h) => h.detach())
  }, 30_000)

  it('PUSH retries recover post-round writes under drops', async () => {
    // Drop ~half the PUSHes from B → A. Without retries the dropped
    // PUSH loses its fact until reconnect; with retries + PUSH_ACK
    // the unacked PUSHes are resent and convergence holds.
    // Higher maxAttempts to handle the property's tail: 0.5^20 ≈
    // 10^-6 chance of all 20 retries dropping for any single PUSH,
    // across 30 PUSHes ≈ 3 in a million.
    const retry = { intervalMs: 50, maxAttempts: 20 }
    const a = new SyncEngine({ replicaId: new Uint8Array([1]), relations: ['R'] })
    const b = new SyncEngine({ replicaId: new Uint8Array([2]), relations: ['R'] })
    const applied: Array<[string, Row]> = []
    a.onRemoteAdd((rel, row) => applied.push([rel, row]))
    const [t1, t2] = inMemoryPair()
    const ta = t1
    const tb = withInterference(
      t2,
      { dropProbability: 0.5 },
      makeRng(0xb00),
    )
    const pa = a.attachPeer(ta, { retry })
    const pb = b.attachPeer(tb, { retry })
    await Promise.all([pa.synced, pb.synced])
    for (let i = 0; i < 30; i++) b.add('R', [i])
    // Give the pump enough ticks to retry the dropped pushes.
    await new Promise((r) => setTimeout(r, 3000))
    expect(a.size).toBe(30)
    expect(b.size).toBe(30)
    expect(toHex(a.rootDigest())).toBe(toHex(b.rootDigest()))
    pa.detach()
    pb.detach()
  }, 30_000)

  it('converges at scale: 10k keys A + 5k different keys B', async () => {
    const a = newEngine(1)
    const b = newEngine(2)
    // Shared facts so they actually overlap. 8000 shared keys; 2000
    // A-only; 5000 B-only. End state should be 15_000 unique facts.
    for (let i = 0; i < 8000; i++) {
      a.engine.add('R', [i])
      b.engine.add('R', [i])
    }
    for (let i = 8000; i < 10_000; i++) a.engine.add('R', [i])
    for (let i = 20_000; i < 25_000; i++) b.engine.add('R', [i])

    const [ta, tb] = inMemoryPair()
    const t0 = Date.now()
    const pa = a.engine.attachPeer(ta)
    const pb = b.engine.attachPeer(tb)
    await Promise.all([pa.synced, pb.synced])
    await new Promise((r) => setTimeout(r, 100))
    const elapsed = Date.now() - t0

    expect(a.engine.size).toBe(15_000)
    expect(b.engine.size).toBe(15_000)
    expect(toHex(a.engine.rootDigest())).toBe(toHex(b.engine.rootDigest()))
    // Sanity: this isn't an inner-loop benchmark, but converging 15k
    // facts should be well under 30s on any modern machine.
    expect(elapsed).toBeLessThan(30_000)
    pa.detach()
    pb.detach()
  }, 60_000)

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

  it('converges with concurrent mid-round writes under interference (property)', async () => {
    // The big one: pre-existing facts on both sides + writes that
    // race the initial round + reorder/latency network + post-round
    // PUSH. Encodes the v2 Quint spec's findings end-to-end.
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 0, max: 99 }), { minLength: 0, maxLength: 8 }),
        fc.uniqueArray(fc.integer({ min: 0, max: 99 }), { minLength: 0, maxLength: 8 }),
        fc.uniqueArray(fc.integer({ min: 100, max: 199 }), { minLength: 0, maxLength: 4 }),
        fc.uniqueArray(fc.integer({ min: 200, max: 299 }), { minLength: 0, maxLength: 4 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        async (aIds, bIds, aMidIds, bMidIds, seed) => {
          const a = newEngine(1)
          const b = newEngine(2)
          for (const i of aIds) a.engine.add('R', [i])
          for (const i of bIds) b.engine.add('R', [i])
          const [t1, t2] = inMemoryPair()
          const ta = withInterference(
            t1,
            { latencyMs: [1, 5], reorderProbability: 0.2 },
            makeRng(seed),
          )
          const tb = withInterference(
            t2,
            { latencyMs: [1, 5], reorderProbability: 0.2 },
            makeRng(seed ^ 0xabcd),
          )
          const pa = a.engine.attachPeer(ta)
          const pb = b.engine.attachPeer(tb)
          // Fire mid-round writes after a small delay so they race
          // the initial round.
          setTimeout(() => {
            for (const i of aMidIds) a.engine.add('R', [i])
          }, 2)
          setTimeout(() => {
            for (const i of bMidIds) b.engine.add('R', [i])
          }, 4)
          await Promise.all([pa.synced, pb.synced])
          // Give PUSH / PAGE_RANGES retries time to fully settle.
          await new Promise((r) => setTimeout(r, 150))
          const rootsMatch = toHex(a.engine.rootDigest()) === toHex(b.engine.rootDigest())
          const sizesMatch = a.engine.size === b.engine.size
          const expectedSize = new Set([...aIds, ...bIds, ...aMidIds, ...bMidIds]).size
          const allConverged = rootsMatch && sizesMatch && a.engine.size === expectedSize
          pa.detach()
          pb.detach()
          return allConverged
        },
      ),
      { numRuns: 25 },
    )
  })
})
