// Bandwidth scaling for the page-range exchange. Two replicas
// sharing most keys exchange one PAGE_RANGES message each, then one
// FETCH/DATA round per side for the actual diff. Identical key sets
// short-circuit at HELLO via the root-digest gate.

import { describe, expect, it } from 'vitest'
import { compareHash, Mst, serialisePageRanges, toHex } from '../../src/mst/index.js'
import {
  MSG_DATA,
  MSG_FETCH,
  MSG_PAGE_RANGES,
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

describe('page-range exchange bandwidth', () => {
  it('disjoint-stores converge with bounded message counts', async () => {
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

    // Both sides converge to the same root.
    expect(toHex(a.mst.rootDigest())).toBe(toHex(b.mst.rootDigest()))
    expect(a.mst.size).toBe(102)
    expect(b.mst.size).toBe(102)

    // Each side sends exactly one PAGE_RANGES (no retries needed on
    // a perfect transport), one FETCH, and responds to peer's FETCH
    // with one DATA.
    for (const counts of [tA.counts, tB.counts]) {
      expect(counts.get(MSG_PAGE_RANGES) ?? 0).toBe(1)
      expect(counts.get(MSG_FETCH) ?? 0).toBeLessThanOrEqual(1)
      expect(counts.get(MSG_DATA) ?? 0).toBe(1)
    }
  })

  it('identical key sets need no PAGE_RANGES / FETCH / DATA at all (root-digest gate)', async () => {
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

    expect(tA.counts.get(MSG_PAGE_RANGES) ?? 0).toBe(0)
    expect(tA.counts.get(MSG_FETCH) ?? 0).toBe(0)
    expect(tA.counts.get(MSG_DATA) ?? 0).toBe(0)
  })
})
