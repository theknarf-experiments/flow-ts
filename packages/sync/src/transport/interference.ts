// Wrap a Transport with simulated network impairments — drop,
// reorder, latency, partition, hard close. RNG is injected so
// fast-check can drive deterministic, shrinkable interference
// profiles.
//
// Semantics:
//   * `dropProbability`: each call to `send` independently has this
//     probability of being silently dropped.
//   * `reorderProbability`: each non-dropped message has this
//     probability of being delivered *after* the next one — modeled
//     as an extra delay drawn from `latencyMs`.
//   * `latencyMs`: [min, max] ms; each non-dropped message is
//     delivered after a uniform random delay in this range.
//   * `partitionAt`: an outbound-message-index predicate; while true,
//     subsequent sends are buffered and only released when the
//     predicate flips back to false. (Used to simulate split-brain
//     and heal.)
//   * `closeAt`: when this predicate returns true for the current
//     outbound-message-index, the transport hard-closes after the
//     send. Models a peer dropping mid-protocol.
//
// We deliberately keep this orthogonal to the protocol layer: the
// wrapper sees opaque `Uint8Array`s and never inspects content.

import type { Transport, Unsubscribe } from './interface.js'

export interface InterferenceKnobs {
  dropProbability?: number
  reorderProbability?: number
  latencyMs?: readonly [number, number]
  partitionAt?: (msgIndex: number) => boolean
  closeAt?: (msgIndex: number) => boolean
}

class InterferingTransport implements Transport {
  #inner: Transport
  #knobs: InterferenceKnobs
  #rng: () => number
  #closed = false
  #outboundCount = 0
  #partitionBuffer: Uint8Array[] = []

  constructor(inner: Transport, knobs: InterferenceKnobs, rng: () => number) {
    this.#inner = inner
    this.#knobs = knobs
    this.#rng = rng
  }

  send(msg: Uint8Array): void {
    if (this.#closed) return
    const idx = this.#outboundCount++
    // Partition: buffer until the partition predicate flips back to false.
    if (this.#knobs.partitionAt && this.#knobs.partitionAt(idx)) {
      this.#partitionBuffer.push(msg)
      this.#tryFlushPartition()
      return
    }
    this.#tryFlushPartition()
    // Drop
    if (this.#knobs.dropProbability && this.#rng() < this.#knobs.dropProbability) return
    // Latency
    const [lo, hi] = this.#knobs.latencyMs ?? [0, 0]
    const baseDelay = lo === hi ? lo : lo + Math.floor(this.#rng() * (hi - lo + 1))
    const reorderBonus =
      this.#knobs.reorderProbability && this.#rng() < this.#knobs.reorderProbability
        ? hi + 1
        : 0
    const delay = baseDelay + reorderBonus
    if (delay <= 0) {
      this.#inner.send(msg)
    } else {
      setTimeout(() => {
        if (!this.#closed) this.#inner.send(msg)
      }, delay)
    }
    // Hard close — defer so in-flight sends queued ahead of us have a
    // chance to deliver. (Mirrors real-world TCP-ish semantics where
    // close after send isn't observably a drop.)
    if (this.#knobs.closeAt && this.#knobs.closeAt(idx)) {
      queueMicrotask(() => this.close())
    }
  }

  #tryFlushPartition(): void {
    if (this.#partitionBuffer.length === 0) return
    const idx = this.#outboundCount - 1
    if (this.#knobs.partitionAt && this.#knobs.partitionAt(idx)) return
    const buf = this.#partitionBuffer
    this.#partitionBuffer = []
    for (const msg of buf) this.#inner.send(msg)
  }

  onMessage(fn: (msg: Uint8Array) => void): Unsubscribe {
    return this.#inner.onMessage(fn)
  }

  onClose(fn: () => void): Unsubscribe {
    return this.#inner.onClose(fn)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#inner.close()
  }
}

export function withInterference(
  inner: Transport,
  knobs: InterferenceKnobs,
  rng: () => number = Math.random,
): Transport {
  return new InterferingTransport(inner, knobs, rng)
}

/** Build a deterministic [0, 1) RNG from a seed. mulberry32. */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
