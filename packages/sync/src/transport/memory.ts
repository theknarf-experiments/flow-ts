// In-process Transport pair, primarily for tests. Each side's `send`
// is delivered synchronously to the other side's listeners. Close on
// one side closes the other.

import type { Transport, Unsubscribe } from './interface.js'

class MemoryTransport implements Transport {
  #messageListeners = new Set<(msg: Uint8Array) => void>()
  #closeListeners = new Set<() => void>()
  #peer: MemoryTransport | null = null
  #closed = false

  send(msg: Uint8Array): void {
    if (this.#closed || !this.#peer || this.#peer.#closed) return
    // Defer so callers don't observe re-entrant listener fires.
    queueMicrotask(() => {
      if (!this.#peer || this.#peer.#closed) return
      for (const fn of this.#peer.#messageListeners) fn(msg)
    })
  }

  onMessage(fn: (msg: Uint8Array) => void): Unsubscribe {
    this.#messageListeners.add(fn)
    return () => {
      this.#messageListeners.delete(fn)
    }
  }

  onClose(fn: () => void): Unsubscribe {
    if (this.#closed) {
      queueMicrotask(fn)
      return () => {}
    }
    this.#closeListeners.add(fn)
    return () => {
      this.#closeListeners.delete(fn)
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const fn of this.#closeListeners) fn()
    this.#closeListeners.clear()
    if (this.#peer && !this.#peer.#closed) this.#peer.close()
  }

  _attach(peer: MemoryTransport): void {
    this.#peer = peer
  }
}

/** Create two transports wired to each other in-process. */
export function inMemoryPair(): [Transport, Transport] {
  const a = new MemoryTransport()
  const b = new MemoryTransport()
  a._attach(b)
  b._attach(a)
  return [a, b]
}
