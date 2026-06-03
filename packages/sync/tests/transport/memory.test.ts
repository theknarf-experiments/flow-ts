import { describe, expect, it } from 'vitest'
import { inMemoryPair, withInterference, makeRng } from '../../src/transport/index.js'

function nextMicrotask(): Promise<void> {
  return new Promise((r) => queueMicrotask(r))
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe('inMemoryPair', () => {
  it('delivers messages between the two sides', async () => {
    const [a, b] = inMemoryPair()
    const received: Uint8Array[] = []
    b.onMessage((m) => received.push(m))
    a.send(new Uint8Array([1, 2, 3]))
    a.send(new Uint8Array([4, 5, 6]))
    await nextMicrotask()
    expect(received.length).toBe(2)
    expect(Array.from(received[0]!)).toEqual([1, 2, 3])
    expect(Array.from(received[1]!)).toEqual([4, 5, 6])
  })

  it('close fires onClose on both sides', async () => {
    const [a, b] = inMemoryPair()
    let aClosed = false
    let bClosed = false
    a.onClose(() => {
      aClosed = true
    })
    b.onClose(() => {
      bClosed = true
    })
    a.close()
    expect(aClosed).toBe(true)
    expect(bClosed).toBe(true)
  })

  it('drops sends after close', async () => {
    const [a, b] = inMemoryPair()
    const received: Uint8Array[] = []
    b.onMessage((m) => received.push(m))
    a.close()
    a.send(new Uint8Array([9]))
    await nextMicrotask()
    expect(received.length).toBe(0)
  })
})

describe('withInterference', () => {
  it('dropProbability=1 means nothing arrives', async () => {
    const [a, b] = inMemoryPair()
    const wrapped = withInterference(a, { dropProbability: 1 }, makeRng(1))
    const received: Uint8Array[] = []
    b.onMessage((m) => received.push(m))
    for (let i = 0; i < 50; i++) wrapped.send(new Uint8Array([i]))
    await sleep(50)
    expect(received.length).toBe(0)
  })

  it('dropProbability=0 with no latency delivers everything in order', async () => {
    const [a, b] = inMemoryPair()
    const wrapped = withInterference(a, {}, makeRng(2))
    const received: Uint8Array[] = []
    b.onMessage((m) => received.push(m))
    for (let i = 0; i < 10; i++) wrapped.send(new Uint8Array([i]))
    await sleep(20)
    expect(received.length).toBe(10)
    for (let i = 0; i < 10; i++) expect(received[i]![0]).toBe(i)
  })

  it('partition buffers and releases on heal', async () => {
    const [a, b] = inMemoryPair()
    let partitioned = true
    const wrapped = withInterference(
      a,
      { partitionAt: () => partitioned },
      makeRng(3),
    )
    const received: Uint8Array[] = []
    b.onMessage((m) => received.push(m))
    for (let i = 0; i < 5; i++) wrapped.send(new Uint8Array([i]))
    await sleep(20)
    expect(received.length).toBe(0) // still partitioned
    partitioned = false
    wrapped.send(new Uint8Array([99])) // flush trigger
    await sleep(20)
    // 5 buffered + 1 trigger = 6
    expect(received.length).toBe(6)
  })

  it('closeAt closes the transport after that send', async () => {
    const [a, b] = inMemoryPair()
    const wrapped = withInterference(a, { closeAt: (i) => i === 2 }, makeRng(4))
    let closed = false
    wrapped.onClose(() => {
      closed = true
    })
    const received: Uint8Array[] = []
    b.onMessage((m) => received.push(m))
    wrapped.send(new Uint8Array([0]))
    wrapped.send(new Uint8Array([1]))
    wrapped.send(new Uint8Array([2])) // closes after this
    await sleep(20)
    expect(closed).toBe(true)
    // Subsequent sends are no-ops.
    wrapped.send(new Uint8Array([3]))
    await sleep(20)
    expect(received.length).toBe(3) // 0, 1, 2 delivered; 3 dropped
  })
})
