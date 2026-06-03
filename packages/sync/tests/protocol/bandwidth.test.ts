// Sanity check on the bandwidth-scaling claim: when two replicas
// share 100 keys and differ on 2, the range-diff walk only descends
// into the subtrees that contain the differing keys — not the full
// tree. We measure by counting RANGE_DIFF messages observed on the
// wire.

import { describe, expect, it } from 'vitest'
import { Mst, toHex } from '../../src/mst/index.js'
import {
  MSG_RANGE_DIFF,
  MSG_RANGE_DATA,
  MSG_RANGE_MATCH,
  MSG_RANGE_SPLIT,
} from '../../src/protocol/messages.js'
import { decodeMessage } from '../../src/protocol/codec.js'
import { factKey, type Fact } from '../../src/protocol/payload.js'
import { SyncSession, type SessionDeps } from '../../src/protocol/session.js'
import { inMemoryPair } from '../../src/transport/index.js'

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

/** Sniffing wrapper that counts per-type messages going *outbound* on
 *  one side. Decodes each message so the count is by semantic type,
 *  not by raw bytes. */
function countingTransport(inner: ReturnType<typeof inMemoryPair>[number]) {
  const counts = new Map<number, number>()
  const wrapped = {
    send(msg: Uint8Array) {
      const m = decodeMessage(msg)
      counts.set(m.type, (counts.get(m.type) ?? 0) + 1)
      inner.send(msg)
    },
    onMessage: inner.onMessage.bind(inner),
    onClose: inner.onClose.bind(inner),
    close: inner.close.bind(inner),
  }
  return { wrapped, counts }
}

describe('range-diff bandwidth scaling', () => {
  it('large shared key set with a small diff yields few RANGE messages', async () => {
    // Both sides have keys 1..100 in 'R'; A also has 'special1', B has 'special2'.
    const shared = Array.from({ length: 100 }, (_, i) => ({
      relation: 'R',
      encodedRow: `${i},`,
    }))
    const a = makeDeps(1, [...shared, { relation: 'R', encodedRow: 'special1,' }])
    const b = makeDeps(2, [...shared, { relation: 'R', encodedRow: 'special2,' }])
    const [t1, t2] = inMemoryPair()
    const tA = countingTransport(t1)
    const tB = countingTransport(t2)
    const sa = new SyncSession(tA.wrapped, a.deps)
    const sb = new SyncSession(tB.wrapped, b.deps)
    sa.start()
    sb.start()
    await Promise.all([sa.completion, sb.completion])

    // Both sides converged.
    expect(toHex(a.mst.rootDigest())).toBe(toHex(b.mst.rootDigest()))
    expect(a.mst.size).toBe(102)
    expect(b.mst.size).toBe(102)

    // A's outbound RANGE_DIFF count: walk pays log2(256/bit-depth) bisections
    // per side until ranges fit MAX_RANGE_KEYS (64). With 101 keys per side
    // and bit-depth-1 split, expect at most a small handful of DIFFs.
    const aDiffs = tA.counts.get(MSG_RANGE_DIFF) ?? 0
    const bDiffs = tB.counts.get(MSG_RANGE_DIFF) ?? 0
    expect(aDiffs).toBeLessThanOrEqual(8)
    expect(bDiffs).toBeLessThanOrEqual(8)

    // And we should see at least one SPLIT (root range exceeds MAX_RANGE_KEYS).
    const aSplits =
      (tA.counts.get(MSG_RANGE_SPLIT) ?? 0) + (tB.counts.get(MSG_RANGE_SPLIT) ?? 0)
    expect(aSplits).toBeGreaterThanOrEqual(1)
  })

  it('identical key sets need no RANGE messages at all (root-digest gate)', async () => {
    const init = Array.from({ length: 50 }, (_, i) => ({
      relation: 'R',
      encodedRow: `${i},`,
    }))
    const a = makeDeps(1, init)
    const b = makeDeps(2, init)
    const [t1, t2] = inMemoryPair()
    const tA = countingTransport(t1)
    const tB = countingTransport(t2)
    const sa = new SyncSession(tA.wrapped, a.deps)
    const sb = new SyncSession(tB.wrapped, b.deps)
    sa.start()
    sb.start()
    await Promise.all([sa.completion, sb.completion])

    expect(tA.counts.get(MSG_RANGE_DIFF) ?? 0).toBe(0)
    expect(tA.counts.get(MSG_RANGE_DATA) ?? 0).toBe(0)
    expect(tA.counts.get(MSG_RANGE_MATCH) ?? 0).toBe(0)
    expect(tA.counts.get(MSG_RANGE_SPLIT) ?? 0).toBe(0)
  })
})
