// The Transport abstraction the sync engine operates against. Callers
// bring their own real-network implementation (WebSocket, WebRTC, …);
// the sync engine only depends on this shape.
//
// Contract:
//   * `send(msg)` is non-blocking and best-effort. Bytes may never
//     arrive, may arrive multiple times, may arrive out of order —
//     the sync protocol is robust to all three.
//   * `onMessage(fn)` registers a listener; it returns an unsubscribe
//     function. Listeners receive each delivered message exactly as
//     it was passed to the peer's `send`.
//   * `onClose(fn)` fires once when the transport is closed (locally
//     via `close()` or by the peer).
//   * `close()` is idempotent.

export type Unsubscribe = () => void

export interface Transport {
  send(msg: Uint8Array): void
  onMessage(fn: (msg: Uint8Array) => void): Unsubscribe
  onClose(fn: () => void): Unsubscribe
  close(): void
}
