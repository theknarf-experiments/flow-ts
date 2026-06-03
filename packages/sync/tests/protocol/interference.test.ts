// Protocol behaviour under simulated network impairments. Range-diff
// + per-RANGE_DIFF retry means we now converge under modest drop too,
// not just reorder + latency. Hard transport close still produces a
// clean rejection.

import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { compareHash, Mst, serialisePageRanges, toHex } from '../../src/mst/index.js'
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
    localKeysSorted: () => {
      const ks = [...mst.keys()]
      ks.sort(compareHash)
      return ks
    },
    localPageRanges: () => serialisePageRanges(mst.root()),
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

  it('converges under 30% packet drop via retries', async () => {
    const a = makeDeps(1, [
      { relation: 'R', encodedRow: '1,' },
      { relation: 'R', encodedRow: '2,' },
      { relation: 'R', encodedRow: '3,' },
    ])
    const b = makeDeps(2, [
      { relation: 'R', encodedRow: '4,' },
      { relation: 'R', encodedRow: '5,' },
      { relation: 'R', encodedRow: '6,' },
    ])
    const [t1, t2] = inMemoryPair()
    const ta = withInterference(t1, { dropProbability: 0.3 }, makeRng(42))
    const tb = withInterference(t2, { dropProbability: 0.3 }, makeRng(43))
    // Allow enough headroom for the unlucky drop runs the retry budget
    // has to absorb: HELLO, the RANGE_DIFF/DATA exchange, *and* DONE
    // all retry independently. 5s budget per item is comfortable.
    const retry = { intervalMs: 20, maxAttempts: 250 }
    const sa = new SyncSession(ta, { ...a.deps, retry })
    const sb = new SyncSession(tb, { ...b.deps, retry })
    sa.start()
    sb.start()
    await Promise.all([sa.completion, sb.completion])
    expect(toHex(a.mst.rootDigest())).toBe(toHex(b.mst.rootDigest()))
    expect(a.mst.size).toBe(6)
    expect(b.mst.size).toBe(6)
  })

  it('fails the session if RANGE_DIFF exhausts its retry budget', async () => {
    const a = makeDeps(1, [])
    const b = makeDeps(2, [{ relation: 'R', encodedRow: '1,' }])
    const [t1, t2] = inMemoryPair()
    // 100% drop on B-side outbound — A's RANGE_DIFF gets answered
    // momentarily? No: B never gets to reply because nothing gets
    // through. Wait — A's RANGE_DIFF is on T1; B sees it; B's reply
    // (RANGE_DATA or whatever) goes via T2. So drop T2-side messages
    // and A will time out waiting for any response.
    const tb = withInterference(t2, { dropProbability: 1 }, makeRng(7))
    const fastFail = { intervalMs: 10, maxAttempts: 3 }
    const sa = new SyncSession(t1, { ...a.deps, retry: fastFail })
    const sb = new SyncSession(tb, { ...b.deps, retry: fastFail })
    sa.start()
    sb.start()
    const [aResult, bResult] = await Promise.allSettled([sa.completion, sb.completion])
    expect(aResult.status).toBe('rejected')
    // B's session may either time out itself (its DIFF also goes
    // unanswered) or stay pending — at minimum A should fail.
    expect([aResult.status, bResult.status]).toContain('rejected')
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
