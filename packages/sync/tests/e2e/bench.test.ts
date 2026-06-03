import { describe, it } from 'vitest'
import { babHash } from '../../src/bab/index.js'
import { Mst } from '../../src/mst/index.js'
import { SyncEngine } from '../../src/engine.js'
import { inMemoryPair } from '../../src/transport/index.js'

describe.skipIf(!process.env.BENCH)('bench', () => {
  it('mst.insert alone', () => {
    for (const n of [1000, 5000, 10000]) {
      const mst = new Mst()
      const keys: Uint8Array[] = []
      for (let i = 0; i < n; i++) {
        keys.push(babHash(new TextEncoder().encode(`k${i}`)))
      }
      const t0 = Date.now()
      for (const k of keys) mst.insert(k)
      console.log(`mst.insert n=${n}: ${Date.now() - t0}ms`)
    }
  }, 60_000)

  it('engine.add alone', () => {
    for (const n of [1000, 5000, 10000]) {
      const a = new SyncEngine({ replicaId: new Uint8Array([1]), relations: ['R'] })
      const t0 = Date.now()
      for (let i = 0; i < n; i++) a.add('R', [i])
      console.log(`engine.add n=${n}: ${Date.now() - t0}ms`)
    }
  }, 60_000)

  it('full sync', async () => {
    for (const n of [500, 1000, 2000]) {
      const a = new SyncEngine({ replicaId: new Uint8Array([1]), relations: ['R'] })
      const b = new SyncEngine({ replicaId: new Uint8Array([2]), relations: ['R'] })
      for (let i = 0; i < n; i++) {
        a.add('R', [i])
        b.add('R', [i + Math.floor(n / 2)])
      }
      const [ta, tb] = inMemoryPair()
      const t0 = Date.now()
      const pa = a.attachPeer(ta)
      const pb = b.attachPeer(tb)
      await Promise.all([pa.synced, pb.synced])
      await new Promise((r) => setTimeout(r, 30))
      console.log(`sync n=${n}: ${Date.now() - t0}ms (size=${a.size})`)
      pa.detach()
      pb.detach()
    }
  }, 120_000)
})
