// One sync session over one transport, between two peers. Uses
// range-based set reconciliation: each peer recursively bisects the
// 256-bit key space and only descends into ranges whose digests
// differ — bandwidth scales as O(diff + log n), not O(n).
//
// Flow (each peer runs its own walk in parallel):
//   1. HELLO with our MST root digest.
//   2. If roots match → walk skipped; send DONE.
//   3. Else, initiate the walk: send RANGE_DIFF for the full
//      key space `[ZERO_HASH, +∞)`.
//   4. On peer RANGE_DIFF: compute our digest for the same range.
//      - Equal → RANGE_MATCH.
//      - Differ + max(local.count, peer.count) ≤ MAX_RANGE_KEYS
//        (or range can't bisect further) → RANGE_DATA with our keys'
//        values in this range.
//      - Otherwise → RANGE_SPLIT at the bit-midpoint.
//   5. On peer RANGE_MATCH/DATA: range resolved, remove from pending.
//      On peer RANGE_SPLIT: replace this range with the two halves
//      in our pending set and send RANGE_DIFFs for both.
//   6. When pending is empty and our walk had been initiated → DONE.
//   7. When DONE both sent and received → round complete.
//
// Symmetric coverage. Each side's walk discovers what it's missing.
// A's walk surfaces facts that A doesn't have; B's walk surfaces
// facts that B doesn't have. No complement-push needed.
//
// After the initial round, the session stays live for `push(facts)`
// gossip until `close()` or the transport closes externally.

import { type Hash } from '../bab/index.js'
import { bytesEqual, compareHash } from '../mst/index.js'
import {
  bisect,
  isAtomicRange,
  rangeSummary,
  sliceRange,
  ZERO_HASH,
} from '../mst/range.js'
import type { Transport, Unsubscribe } from '../transport/index.js'
import {
  MSG_DONE,
  MSG_ERROR,
  MSG_HELLO,
  MSG_PUSH,
  MSG_RANGE_DATA,
  MSG_RANGE_DIFF,
  MSG_RANGE_MATCH,
  MSG_RANGE_SPLIT,
  type Bound,
  type Message,
  PROTOCOL_VERSION,
} from './messages.js'
import { decodeMessage, encodeMessage } from './codec.js'
import { decodePayload, encodePayload, factKey, type Fact } from './payload.js'

/** Above this size the responder issues SPLIT instead of DATA. */
const MAX_RANGE_KEYS = 64

/** Default retry timing for RANGE_DIFF. Tunable via SessionDeps. */
const DEFAULT_RETRY_INTERVAL_MS = 100
const DEFAULT_MAX_ATTEMPTS = 8

export interface RetryOptions {
  /** How long to wait for a RANGE_DIFF reply before resending. */
  intervalMs?: number
  /** How many times to send the same RANGE_DIFF before failing the
   *  session. Initial send counts as attempt 1. */
  maxAttempts?: number
}

export interface SessionDeps {
  /** Bytes identifying this replica. Only echoed in HELLO; not used
   *  for anything semantic in v1. */
  readonly replicaId: Uint8Array
  /** All keys currently in the local MST, as 32-byte hashes. */
  readonly localKeys: () => Hash[]
  /** Root digest of the local MST. */
  readonly localRoot: () => Hash
  /** Look up a fact's (relation, encodedRow) by its key. Returns
   *  null if we don't have it. */
  readonly lookupFact: (key: Hash) => { relation: string; encodedRow: string } | null
  /** Called for every fact the peer ships us. Caller should add it
   *  to local MST + side-table + emit to onRemoteAdd subscribers. */
  readonly onRemoteFact: (relation: string, encodedRow: string) => void
  /** Optional retry tuning. Defaults: 100ms interval, 8 attempts. */
  readonly retry?: RetryOptions
}

export class SessionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionError'
  }
}

function rangeKey(lo: Hash, hi: Bound): string {
  return toHex(lo) + ':' + (hi === null ? '+' : toHex(hi))
}

export class SyncSession {
  readonly #transport: Transport
  readonly #deps: SessionDeps

  #unsubMessage: Unsubscribe | null = null
  #unsubClose: Unsubscribe | null = null

  /** Snapshot of local keys, sorted. Resorted on every call — the
   *  engine's edits are append-only and small enough that the cost
   *  is fine for v1. */
  #sortedKeys(): Hash[] {
    return this.#deps.localKeys().sort(compareHash)
  }

  /** Ranges we've sent RANGE_DIFF for and are awaiting a final reply.
   *  Each entry tracks attempt count so the shared retry pump can
   *  resend after a timeout and fail-fast after exhaustion. */
  #pending = new Map<string, { lo: Hash; hi: Bound; attempts: number }>()
  #helloReceived = false
  #helloAttempts = 0
  #doneAttempts = 0
  /** Shared interval timer driving retry of HELLO and RANGE_DIFF.
   *  Started in `start()`; cleared on round completion or failure. */
  #retryPump: ReturnType<typeof setInterval> | null = null
  /** True once we've sent the initial RANGE_DIFF (or decided to skip
   *  the walk because roots matched). */
  #walkInitiated = false
  #localDoneSent = false
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
    this.#sendHello()
    const intervalMs = this.#deps.retry?.intervalMs ?? DEFAULT_RETRY_INTERVAL_MS
    this.#retryPump = setInterval(() => this.#tick(), intervalMs)
  }

  #sendHello(): void {
    this.#helloAttempts++
    this.#send({
      type: MSG_HELLO,
      version: PROTOCOL_VERSION,
      replica: this.#deps.replicaId,
      root: this.#deps.localRoot(),
    })
  }

  /** Shared retry tick. Resends anything still pending and bumps
   *  per-item attempt counts; fails the session when any counter
   *  exceeds maxAttempts. */
  #tick(): void {
    if (this.#closed || this.#roundComplete) return
    const max = this.#deps.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS

    if (!this.#helloReceived) {
      if (this.#helloAttempts >= max) {
        this.#fail(new SessionError(`hello: exceeded ${max} attempts`))
        return
      }
      this.#sendHello()
    }

    for (const [key, entry] of this.#pending) {
      if (entry.attempts >= max) {
        this.#fail(new SessionError(`range ${key}: exceeded ${max} attempts`))
        return
      }
      // Recompute digest in case local state moved since first send.
      const sorted = this.#sortedKeys()
      const s = rangeSummary(sorted, entry.lo, entry.hi)
      entry.attempts++
      this.#send({ type: MSG_RANGE_DIFF, lo: entry.lo, hi: entry.hi, digest: s.digest, count: s.count })
    }

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
        case MSG_DONE:
          // Informational only — peer hints they're done with their walk.
          // We don't gate completion on it; see `#maybeFinish`.
          break
        case MSG_ERROR:
          this.#fail(new SessionError(`peer ${m.code}: ${m.msg}`))
          return
        case MSG_PUSH:
          this.#onPush(m)
          break
        case MSG_RANGE_DIFF:
          this.#onRangeDiff(m)
          break
        case MSG_RANGE_MATCH:
          this.#onRangeMatch(m)
          break
        case MSG_RANGE_SPLIT:
          this.#onRangeSplit(m)
          break
        case MSG_RANGE_DATA:
          this.#onRangeData(m)
          break
      }
    } catch (e) {
      this.#fail(e instanceof Error ? e : new SessionError(String(e)))
      return
    }
    this.#maybeFinish()
  }

  #onHello(m: Message & { type: typeof MSG_HELLO }): void {
    this.#helloReceived = true
    if (bytesEqual(this.#deps.localRoot(), m.root)) {
      this.#walkInitiated = true
      // Pending is empty; #maybeFinish will send DONE.
    } else {
      this.#initiateWalk()
    }
  }

  #initiateWalk(): void {
    if (this.#walkInitiated) return
    this.#walkInitiated = true
    const sorted = this.#sortedKeys()
    const s = rangeSummary(sorted, ZERO_HASH, null)
    this.#sendRangeDiff(ZERO_HASH, null, s.digest, s.count)
  }

  #sendRangeDiff(lo: Hash, hi: Bound, digest: Hash, count: number): void {
    const key = rangeKey(lo, hi)
    let entry = this.#pending.get(key)
    if (!entry) {
      entry = { lo, hi, attempts: 0 }
      this.#pending.set(key, entry)
    }
    entry.attempts++
    this.#send({ type: MSG_RANGE_DIFF, lo, hi, digest, count })
  }

  #resolveRange(key: string): void {
    this.#pending.delete(key)
  }

  #clearAllPending(): void {
    this.#pending.clear()
    if (this.#retryPump) {
      clearInterval(this.#retryPump)
      this.#retryPump = null
    }
  }

  #onRangeDiff(m: Message & { type: typeof MSG_RANGE_DIFF }): void {
    const sorted = this.#sortedKeys()
    const local = rangeSummary(sorted, m.lo, m.hi)
    if (bytesEqual(local.digest, m.digest)) {
      this.#send({ type: MSG_RANGE_MATCH, lo: m.lo, hi: m.hi })
      return
    }
    const splitMid = bisect(m.lo, m.hi)
    const shouldShip =
      splitMid === null ||
      isAtomicRange(m.lo, m.hi) ||
      Math.max(local.count, m.count) <= MAX_RANGE_KEYS
    if (shouldShip) {
      const { keys: rangeKeys } = sliceRange(sorted, m.lo, m.hi)
      const facts: Fact[] = []
      for (const k of rangeKeys) {
        const v = this.#deps.lookupFact(k)
        if (!v) continue
        facts.push({ key: k, relation: v.relation, encodedRow: v.encodedRow })
      }
      const { digest, encoded } = encodePayload(facts)
      this.#send({ type: MSG_RANGE_DATA, lo: m.lo, hi: m.hi, digest, encoded })
    } else {
      this.#send({ type: MSG_RANGE_SPLIT, lo: m.lo, mid: splitMid, hi: m.hi })
    }
  }

  #onRangeMatch(m: Message & { type: typeof MSG_RANGE_MATCH }): void {
    this.#resolveRange(rangeKey(m.lo, m.hi))
  }

  #onRangeSplit(m: Message & { type: typeof MSG_RANGE_SPLIT }): void {
    this.#resolveRange(rangeKey(m.lo, m.hi))
    const sorted = this.#sortedKeys()
    const left = rangeSummary(sorted, m.lo, m.mid)
    const right = rangeSummary(sorted, m.mid, m.hi)
    this.#sendRangeDiff(m.lo, m.mid, left.digest, left.count)
    this.#sendRangeDiff(m.mid, m.hi, right.digest, right.count)
  }

  #onRangeData(m: Message & { type: typeof MSG_RANGE_DATA }): void {
    const facts = decodePayload(m.digest, m.encoded)
    for (const f of facts) this.#deps.onRemoteFact(f.relation, f.encodedRow)
    this.#resolveRange(rangeKey(m.lo, m.hi))
  }

  #onPush(m: Message & { type: typeof MSG_PUSH }): void {
    const facts = decodePayload(m.digest, m.encoded)
    for (const f of facts) this.#deps.onRemoteFact(f.relation, f.encodedRow)
  }

  #maybeFinish(): void {
    // Each side resolves its completion when *its own* walk is done.
    // We don't wait for a mutual DONE handshake — there's a "last DONE
    // ack" gap that the protocol can't close without an unbounded
    // retry tail, and demos don't need mutual confirmation. DONE is
    // still sent as an informational hint so the peer can stop
    // expecting more RANGE_DIFFs from us, but it's best-effort.
    if (!this.#walkInitiated || this.#pending.size !== 0 || this.#roundComplete) return
    if (!this.#localDoneSent) {
      this.#localDoneSent = true
      this.#doneAttempts = 1
      this.#send({ type: MSG_DONE })
    }
    this.#finish()
  }

  #finish(): void {
    if (this.#roundComplete) return
    this.#roundComplete = true
    this.#clearAllPending()
    this.#resolve()
  }

  /** Tear down the session and close the transport. Idempotent. */
  close(): void {
    if (this.#closed) return
    if (this.#roundComplete) {
      this.#closed = true
      this.#clearAllPending()
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
    this.#clearAllPending()
    this.#unsubMessage?.()
    this.#unsubClose?.()
    if (!this.#roundComplete) this.#reject(e)
  }

  #onClose(): void {
    if (this.#closed) return
    this.#fail(new SessionError('transport closed before round complete'))
  }

  /** Push one or more facts to the peer. May be called any time after
   *  `start()`. Receivers dedup against their own MST. No ack. */
  push(facts: { relation: string; encodedRow: string }[]): void {
    if (this.#closed) return
    if (facts.length === 0) return
    const fullFacts = facts.map((f) => ({
      key: factKey(f.relation, f.encodedRow),
      relation: f.relation,
      encodedRow: f.encodedRow,
    }))
    const { digest, encoded } = encodePayload(fullFacts)
    this.#send({ type: MSG_PUSH, digest, encoded })
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
