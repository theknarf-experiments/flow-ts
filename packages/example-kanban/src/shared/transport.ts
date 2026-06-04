// Adapter that turns a WebTransport bidirectional stream into the
// `Transport` interface @flow-ts/sync expects (`send / onMessage /
// onClose / close`). The browser exposes WebTransport bidi streams
// as `{ writable: WritableStream, readable: ReadableStream }`; the
// `@fails-components/webtransport` server library does the same.
// The shape works the same on both sides.
//
// WebTransport streams are byte-oriented — not message-oriented —
// so we frame each Transport message with a 4-byte big-endian
// length prefix and reassemble on the reader side.

import type { Transport, Unsubscribe } from '@flow-ts/sync'

interface BidiStream {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
}

export function bidiStreamTransport(bidi: BidiStream): Transport {
  const messageHandlers = new Set<(msg: Uint8Array) => void>()
  const closeHandlers = new Set<() => void>()
  let closed = false

  const writer = bidi.writable.getWriter()
  const reader = bidi.readable.getReader()

  function handleClose(): void {
    if (closed) return
    closed = true
    for (const h of closeHandlers) h()
    messageHandlers.clear()
    closeHandlers.clear()
    writer.close().catch(() => {})
    reader.cancel().catch(() => {})
  }

  // Read loop: accumulate bytes, dispatch each length-prefixed frame.
  let buffer = new Uint8Array(0)
  ;(async () => {
    while (!closed) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch {
        handleClose()
        return
      }
      if (chunk.done) {
        handleClose()
        return
      }
      // Concatenate chunk into the read buffer.
      const next = new Uint8Array(buffer.length + chunk.value.length)
      next.set(buffer)
      next.set(chunk.value, buffer.length)
      buffer = next
      // Peel off complete frames.
      while (buffer.length >= 4) {
        const len = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0, false)
        if (buffer.length < 4 + len) break
        const msg = buffer.slice(4, 4 + len)
        buffer = buffer.slice(4 + len)
        for (const h of messageHandlers) h(msg)
      }
    }
  })().catch(handleClose)

  return {
    send(msg: Uint8Array): void {
      if (closed) return
      const framed = new Uint8Array(4 + msg.length)
      new DataView(framed.buffer).setUint32(0, msg.length, false)
      framed.set(msg, 4)
      writer.write(framed).catch(() => handleClose())
    },
    onMessage(fn): Unsubscribe {
      messageHandlers.add(fn)
      return () => {
        messageHandlers.delete(fn)
      }
    },
    onClose(fn): Unsubscribe {
      closeHandlers.add(fn)
      return () => {
        closeHandlers.delete(fn)
      }
    },
    close(): void {
      handleClose()
    },
  }
}
