// Protocol behaviour under simulated network impairments. The v1
// protocol doesn't retry, so completion under heavy drop isn't
// expected — but it MUST converge under reorder + latency, and it
// MUST fail cleanly (rejected completion) under hard drops mid-round.

import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { Mst, toHex } from '../../src/mst/index.js'
import { factKey, type Fact } from '../../src/protocol/payload.js'
import { SyncSession, type SessionDeps } from '../../src/protocol/session.js'
import { inMemoryPair, makeRng, withInterference } from '../../src/transport/index.js'

function makeDeps(replica: number, initial: { relation: string; encodedRow: string }[]) {
  const mst = new Mst()
  const facts = new Map<string, { relation: string; encodedRow: string }>()
  const remoteFacts: Fact[] = []
  for (const f of initial) {
    const k = factKey(f.relation, f.encodedRow)
    mst.insert(k)
    facts.set(toHex(k), f)
  }
  const deps: SessionDeps = {
    replicaId: new Uint8Array([replica]),
    localKeys: () => [...mst.keys()],
    localRoot: () => mst.rootDigest(),
    lookupFact: (k) => facts.get(toHex(k)) ?? null,
    onRemoteFact: (relation, encodedRow) => {
      const key = factKey(relation, encodedRow)
      mst.insert(key)
      facts.set(toHex(key), { relation, encodedRow })
      remoteFacts.push({ key, relation, encodedRow })
    },
  }
  return { deps, mst, facts, remoteFacts }
}

describe('SyncSession under interference', () => {
  it('converges under bounded latency + reorder', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 0, max: 9999 }), { minLength: 1, maxLength: 25 }),
        fc.uniqueArray(fc.integer({ min: 0, max: 9999 }), { minLength: 0, maxLength: 25 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        async (aIds, bIds, seed) => {
          const aFacts = aIds.map((i) => ({ relation: 'R', encodedRow: `${i},` }))
          const bFacts = bIds.map((i) => ({ relation: 'R', encodedRow: `${i},` }))
          const a = makeDeps(1, aFacts)
          const b = makeDeps(2, bFacts)
          const [t1, t2] = inMemoryPair()
          const ta = withInterference(
            t1,
            { latencyMs: [1, 8], reorderProbability: 0.3 },
            makeRng(seed),
          )
          const tb = withInterference(
            t2,
            { latencyMs: [1, 8], reorderProbability: 0.3 },
            makeRng(seed ^ 0xdeadbeef),
          )
          const sa = new SyncSession(ta, a.deps)
          const sb = new SyncSession(tb, b.deps)
          sa.start()
          sb.start()
          await Promise.all([sa.completion, sb.completion])
          return toHex(a.mst.rootDigest()) === toHex(b.mst.rootDigest())
        },
      ),
      { numRuns: 15 },
    )
  })

  it('rejects when the transport closes mid-round', async () => {
    const a = makeDeps(1, [])
    const b = makeDeps(2, [
      { relation: 'R', encodedRow: '1,' },
      { relation: 'R', encodedRow: '2,' },
      { relation: 'R', encodedRow: '3,' },
    ])
    const [t1, t2] = inMemoryPair()
    // Close A's transport after its first outbound message (HELLO).
    // Both sessions should observe a close and reject.
    const ta = withInterference(t1, { closeAt: (i) => i === 0 }, makeRng(1))
    const sa = new SyncSession(ta, a.deps)
    const sb = new SyncSession(t2, b.deps)
    sa.start()
    sb.start()
    const [aResult, bResult] = await Promise.allSettled([sa.completion, sb.completion])
    expect(aResult.status).toBe('rejected')
    expect(bResult.status).toBe('rejected')
  })
})
