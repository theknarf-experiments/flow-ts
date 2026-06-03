// Happy-path protocol tests. Two SessionDeps in-process, in-memory
// transport, no interference.

import { describe, expect, it } from 'vitest'
import { babHash } from '../../src/bab/index.js'
import { Mst, toHex } from '../../src/mst/index.js'
import { factKey, type Fact } from '../../src/protocol/payload.js'
import { SyncSession, type SessionDeps } from '../../src/protocol/session.js'
import { inMemoryPair } from '../../src/transport/index.js'

/** Build a SessionDeps from an initial set of facts. The deps mirror
 *  what the eventual SyncEngine will provide. */
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

describe('SyncSession — handshake', () => {
  it('converges two empty replicas', async () => {
    const a = makeDeps(1, [])
    const b = makeDeps(2, [])
    const [ta, tb] = inMemoryPair()
    const sa = new SyncSession(ta, a.deps)
    const sb = new SyncSession(tb, b.deps)
    sa.start()
    sb.start()
    await Promise.all([sa.completion, sb.completion])
    expect(toHex(a.mst.rootDigest())).toBe(toHex(b.mst.rootDigest()))
  })

  it('skips key exchange when roots already match', async () => {
    const init = [{ relation: 'R', encodedRow: '1,2,' }]
    const a = makeDeps(1, init)
    const b = makeDeps(2, init)
    const [ta, tb] = inMemoryPair()
    const sa = new SyncSession(ta, a.deps)
    const sb = new SyncSession(tb, b.deps)
    sa.start()
    sb.start()
    await Promise.all([sa.completion, sb.completion])
    // Both still have the same one fact; neither side gained anything.
    expect(a.remoteFacts.length).toBe(0)
    expect(b.remoteFacts.length).toBe(0)
  })

  it('one-sided: A has facts, B has nothing → B catches up', async () => {
    const a = makeDeps(1, [
      { relation: 'R', encodedRow: '1,2,' },
      { relation: 'R', encodedRow: '3,4,' },
      { relation: 'S', encodedRow: "'hello," },
    ])
    const b = makeDeps(2, [])
    const [ta, tb] = inMemoryPair()
    const sa = new SyncSession(ta, a.deps)
    const sb = new SyncSession(tb, b.deps)
    sa.start()
    sb.start()
    await Promise.all([sa.completion, sb.completion])
    expect(toHex(a.mst.rootDigest())).toBe(toHex(b.mst.rootDigest()))
    expect(b.remoteFacts.length).toBe(3)
    expect(a.remoteFacts.length).toBe(0)
  })

  it('both sides have disjoint facts → both sides converge', async () => {
    const a = makeDeps(1, [
      { relation: 'R', encodedRow: '1,2,' },
      { relation: 'R', encodedRow: '3,4,' },
    ])
    const b = makeDeps(2, [
      { relation: 'R', encodedRow: '5,6,' },
      { relation: 'S', encodedRow: "'foo," },
    ])
    const [ta, tb] = inMemoryPair()
    const sa = new SyncSession(ta, a.deps)
    const sb = new SyncSession(tb, b.deps)
    sa.start()
    sb.start()
    await Promise.all([sa.completion, sb.completion])
    expect(toHex(a.mst.rootDigest())).toBe(toHex(b.mst.rootDigest()))
    // Each side gained the facts it didn't have.
    expect(a.remoteFacts.length).toBe(2)
    expect(b.remoteFacts.length).toBe(2)
    expect(a.mst.size).toBe(4)
    expect(b.mst.size).toBe(4)
  })

  it('rejects DATA with a corrupted bab payload', async () => {
    const a = makeDeps(1, [])
    const b = makeDeps(2, [
      { relation: 'R', encodedRow: '1,2,' },
      { relation: 'R', encodedRow: '3,4,' },
    ])
    const [ta, tb] = inMemoryPair()
    // A DATA message is a 3-element CBOR array starting with major-tag
    // 0x83 then the type byte 0x04. Sniff that header and flip a byte
    // near the tail of the encoded payload (so the digest mismatches
    // after bab decode rather than just being noise the CBOR layer
    // rejects).
    const tbWrapped = {
      send(msg: Uint8Array) {
        if (msg.length >= 6 && msg[0] === 0x83 && msg[1] === 0x04) {
          const c = new Uint8Array(msg)
          c[msg.length - 5] ^= 0xff
          tb.send(c)
          return
        }
        tb.send(msg)
      },
      onMessage: tb.onMessage.bind(tb),
      onClose: tb.onClose.bind(tb),
      close: tb.close.bind(tb),
    }
    const sa = new SyncSession(ta, a.deps)
    const sb = new SyncSession(tbWrapped, b.deps)
    sa.start()
    sb.start()
    await expect(sa.completion).rejects.toThrow()
  })

  it('peer asking for a key we no longer have is silently ignored', async () => {
    // Construct an A that responds with empty payloads for unknown keys.
    const a = makeDeps(1, [])
    const b = makeDeps(2, [])
    // Add a fake key to b's lookup table (it knows the key but the
    // backing relation entry will be missing) — simulating a stale
    // peer. We hack this by injecting a key into b's localKeys but
    // not into b's facts map.
    const fakeKey = factKey('Ghost', '99,')
    const bDeps: SessionDeps = {
      ...b.deps,
      localKeys: () => [fakeKey],
      localRoot: () => babHash(fakeKey), // fake non-matching root
    }
    const [ta, tb] = inMemoryPair()
    const sa = new SyncSession(ta, a.deps)
    const sb = new SyncSession(tb, bDeps)
    sa.start()
    sb.start()
    await Promise.all([sa.completion, sb.completion])
    // A fetched the fake key from B; B couldn't supply it; A applied 0 facts.
    expect(a.remoteFacts.length).toBe(0)
  })
})
