// One sync session over one transport, between two peers. The session
// is the state-machine layer — it drives a single round of
// reconciliation from HELLO to mutual DONE, and resolves a Promise
// when the round is complete (or rejects on transport failure).
//
// Flow (each side runs in parallel):
//   1. Send HELLO with our MST root digest.
//   2. On peer HELLO: if roots match, mark in/out as complete and
//      send DONE. Else send KEYS.
//   3. On peer KEYS: compute (peer\local), send FETCH for those keys.
//      If empty, mark "inbound complete" (no DATA expected).
//   4. On peer FETCH: build a bab-encoded DATA payload and send.
//      Mark "outbound complete".
//   5. On peer DATA: bab-verify, decode, apply each fact.
//      Mark "inbound complete".
//   6. When in+out complete: send DONE. When DONE both sent and
//      received: round complete.
//
// Idempotent: receiving DONE twice or DATA twice is benign.

import { bytesEqual, type Hash } from '../mst/index.js'
import type { Transport, Unsubscribe } from '../transport/index.js'
import {
  MSG_DATA,
  MSG_DONE,
  MSG_ERROR,
  MSG_FETCH,
  MSG_HELLO,
  MSG_KEYS,
  MSG_PUSH,
  type Message,
  PROTOCOL_VERSION,
} from './messages.js'
import { decodeMessage, encodeMessage } from './codec.js'
import { decodePayload, encodePayload, factKey as factKeyFromCanon, type Fact } from './payload.js'

export interface SessionDeps {
  /** Caller-side hooks. The session never touches the MST directly —
   *  it goes through these to keep the layer decoupled. */
  /** Bytes identifying this replica. Only echoed in HELLO; not used
   *  for anything semantic in v1. */
  readonly replicaId: Uint8Array
  /** All keys currently in the local MST, as 32-byte hashes. */
  readonly localKeys: () => Hash[]
  /** Root digest of the local MST. */
  readonly localRoot: () => Hash
  /** Look up a fact's (relation, encodedRow) by its key. Returns
   *  null if we don't have it (shouldn't happen if the peer's FETCH
   *  is well-formed). */
  readonly lookupFact: (key: Hash) => { relation: string; encodedRow: string } | null
  /** Called for every fact the peer ships us. Caller should add it
   *  to local MST + side-table + emit to onRemoteAdd subscribers. */
  readonly onRemoteFact: (relation: string, encodedRow: string) => void
}

export class SessionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionError'
  }
}

export class SyncSession {
  readonly #transport: Transport
  readonly #deps: SessionDeps

  #unsubMessage: Unsubscribe | null = null
  #unsubClose: Unsubscribe | null = null

  // Inbound = we've gotten what we need from peer (DATA reply to our
  //           FETCH, or roots matched).
  // Outbound = we've answered the peer's needs (replied DATA to
  //            their FETCH, or roots matched).
  #inboundComplete = false
  #outboundComplete = false
  #localDoneSent = false
  #peerDoneReceived = false
  /** Initial reconcile round done; session stays live for PUSH. */
  #roundComplete = false
  /** Transport unhooked; no further send/receive. */
  #closed = false

  #resolve!: () => void
  #reject!: (e: Error) => void
  readonly completion: Promise<void>

  constructor(transport: Transport, deps: SessionDeps) {
    this.#transport = transport
    this.#deps = deps
    this.completion = new Promise<void>((res, rej) => {
      this.#resolve = res
      this.#reject = rej
    })
  }

  start(): void {
    this.#unsubMessage = this.#transport.onMessage((m) => this.#onMessage(m))
    this.#unsubClose = this.#transport.onClose(() => this.#onClose())
    this.#send({
      type: MSG_HELLO,
      version: PROTOCOL_VERSION,
      replica: this.#deps.replicaId,
      root: this.#deps.localRoot(),
    })
  }

  #send(m: Message): void {
    this.#transport.send(encodeMessage(m))
  }

  #onMessage(buf: Uint8Array): void {
    if (this.#closed) return
    let m: Message
    try {
      m = decodeMessage(buf)
    } catch (e) {
      this.#fail(new SessionError(`decode: ${(e as Error).message}`))
      return
    }
    try {
      switch (m.type) {
        case MSG_HELLO:
          this.#onHello(m)
          break
        case MSG_KEYS:
          this.#onKeys(m)
          break
        case MSG_FETCH:
          this.#onFetch(m)
          break
        case MSG_DATA:
          this.#onData(m)
          break
        case MSG_DONE:
          this.#peerDoneReceived = true
          break
        case MSG_ERROR:
          this.#fail(new SessionError(`peer ${m.code}: ${m.msg}`))
          return
        case MSG_PUSH:
          this.#onPush(m)
          break
      }
    } catch (e) {
      this.#fail(e instanceof Error ? e : new SessionError(String(e)))
      return
    }
    this.#maybeFinish()
  }

  #onHello(m: Message & { type: typeof MSG_HELLO }): void {
    if (bytesEqual(this.#deps.localRoot(), m.root)) {
      // Roots match — no key exchange needed.
      this.#inboundComplete = true
      this.#outboundComplete = true
    } else {
      this.#send({ type: MSG_KEYS, keys: this.#deps.localKeys() })
    }
  }

  #onKeys(m: Message & { type: typeof MSG_KEYS }): void {
    const localHex = new Set(this.#deps.localKeys().map(toHex))
    const want: Hash[] = []
    for (const k of m.keys) {
      if (!localHex.has(toHex(k))) want.push(k)
    }
    this.#send({ type: MSG_FETCH, keys: want })
    if (want.length === 0) this.#inboundComplete = true
  }

  #onFetch(m: Message & { type: typeof MSG_FETCH }): void {
    const facts: Fact[] = []
    for (const k of m.keys) {
      const v = this.#deps.lookupFact(k)
      if (!v) continue // peer asked for a key we don't have — skip silently
      facts.push({ key: k, relation: v.relation, encodedRow: v.encodedRow })
    }
    const { digest, encoded } = encodePayload(facts)
    this.#send({ type: MSG_DATA, digest, encoded })
    this.#outboundComplete = true
  }

  #onData(m: Message & { type: typeof MSG_DATA }): void {
    if (this.#inboundComplete) return // duplicate; ignore
    const facts = decodePayload(m.digest, m.encoded)
    for (const f of facts) this.#deps.onRemoteFact(f.relation, f.encodedRow)
    this.#inboundComplete = true
  }

  #onPush(m: Message & { type: typeof MSG_PUSH }): void {
    const facts = decodePayload(m.digest, m.encoded)
    for (const f of facts) this.#deps.onRemoteFact(f.relation, f.encodedRow)
  }

  /** Push one or more facts to the peer. May be called any time after
   *  `start()` — even before the initial round completes; receivers
   *  dedup against their own MST. No ack; this is gossip, not RPC. */
  push(facts: { relation: string; encodedRow: string }[]): void {
    if (this.#closed) return
    if (facts.length === 0) return
    const fullFacts = facts.map((f) => ({
      key: factKeyFromCanon(f.relation, f.encodedRow),
      relation: f.relation,
      encodedRow: f.encodedRow,
    }))
    const { digest, encoded } = encodePayload(fullFacts)
    this.#send({ type: MSG_PUSH, digest, encoded })
  }

  #maybeFinish(): void {
    if (!this.#localDoneSent && this.#inboundComplete && this.#outboundComplete) {
      this.#localDoneSent = true
      this.#send({ type: MSG_DONE })
    }
    if (!this.#roundComplete && this.#localDoneSent && this.#peerDoneReceived) {
      this.#finish()
    }
  }

  #finish(): void {
    if (this.#roundComplete) return
    this.#roundComplete = true
    // Note: we do NOT unsubscribe from the transport. The session
    // stays live for post-round PUSH traffic until `close()` or the
    // transport closes externally.
    this.#resolve()
  }

  /** Tear down the session and close the transport. Idempotent. */
  close(): void {
    if (this.#closed) return
    if (this.#roundComplete) {
      this.#closed = true
      this.#unsubMessage?.()
      this.#unsubClose?.()
      this.#transport.close()
      return
    }
    this.#fail(new SessionError('session closed locally'))
  }

  #fail(e: Error): void {
    if (this.#closed) return
    this.#closed = true
    this.#unsubMessage?.()
    this.#unsubClose?.()
    if (!this.#roundComplete) this.#reject(e)
  }

  #onClose(): void {
    if (this.#closed) return
    this.#fail(new SessionError('transport closed before round complete'))
  }
}

function toHex(h: Hash): string {
  let s = ''
  for (let i = 0; i < h.length; i++) {
    const b = h[i]!
    s += (b >>> 4).toString(16) + (b & 0xf).toString(16)
  }
  return s
}
