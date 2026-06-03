// One sync session over one transport, between two peers. Uses
// tree-aligned page-range reconciliation: each peer serialises its
// own MST page boundaries (one `(start, end, hash)` triple per page,
// pre-order) and exchanges them in a single PAGE_RANGES message.
// Each side then runs `diff(localRanges, peerRanges)` locally to
// compute the inclusive key ranges it needs to FETCH from the peer.
//
// Bandwidth: O(pages) for the PAGE_RANGES exchange + O(diff) for
// the FETCH/DATA payload. For an MST with the canonical base-16
// level, pages ≈ n / 16 ≈ ~6% of n. Much smaller than the v1's full
// key-list exchange when stores are large and mostly in sync.
//
// Flow (each peer runs in parallel):
//   1. HELLO with our MST root digest.
//   2. If peer root matches → walk skipped; declare done.
//   3. Else send PAGE_RANGES with our serialised page list.
//   4. On peer PAGE_RANGES: run `diff(ours, theirs)`; if non-empty,
//      send FETCH with the resulting ranges. If empty (we don't
//      need anything from them), our inbound side is done.
//   5. On peer FETCH: gather our facts whose keys fall in the
//      requested ranges; ship them via DATA.
//   6. On peer DATA: bab-verify, apply each fact.
//   7. When *our* walk is locally complete (we've received their
//      page ranges and our FETCH has returned), declare round done
//      and send DONE as an informational hint.
//
// After the initial round the session stays live for `push(facts)`
// gossip until `close()` or the transport closes externally.

import { type Hash } from '../bab/index.js'
import { bytesEqual, compareHash } from '../mst/index.js'
import { diff, keysInRanges, type DiffRange, type PageRange } from '../mst/page-range.js'
import type { Transport, Unsubscribe } from '../transport/index.js'
import {
  MSG_DATA,
  MSG_DONE,
  MSG_ERROR,
  MSG_FETCH,
  MSG_HELLO,
  MSG_PAGE_RANGES,
  MSG_PUSH,
  type Message,
  PROTOCOL_VERSION,
} from './messages.js'
import { decodeMessage, encodeMessage } from './codec.js'
import { decodePayload, encodePayload, factKey, type Fact } from './payload.js'

/** Default retry timing. Tunable via SessionDeps. */
const DEFAULT_RETRY_INTERVAL_MS = 100
const DEFAULT_MAX_ATTEMPTS = 8

export interface RetryOptions {
  /** How long to wait for an expected reply before resending the
   *  most recent outbound HELLO / PAGE_RANGES / FETCH. */
  intervalMs?: number
  /** How many times to resend the same message before failing the
   *  session. Initial send counts as attempt 1. */
  maxAttempts?: number
}

export interface SessionDeps {
  /** Bytes identifying this replica. Only echoed in HELLO. */
  readonly replicaId: Uint8Array
  /** All keys currently in the local MST, as 32-byte hashes,
   *  sorted ascending. */
  readonly localKeysSorted: () => Hash[]
  /** Local MST's serialised page ranges (pre-order DFS over its
   *  pages). Re-serialised on every call (the engine's MST is the
   *  source of truth). */
  readonly localPageRanges: () => PageRange[]
  /** Root digest of the local MST. */
  readonly localRoot: () => Hash
  /** Look up a fact's (relation, encodedRow) by its key. Returns
   *  null if we don't have it. */
  readonly lookupFact: (key: Hash) => { relation: string; encodedRow: string } | null
  /** Called for every fact the peer ships us. Caller should add it
   *  to local MST + side-table + emit to onRemoteAdd subscribers. */
  readonly onRemoteFact: (relation: string, encodedRow: string) => void
  /** Optional retry tuning. */
  readonly retry?: RetryOptions
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

  /** Shared retry pump. Resends HELLO / PAGE_RANGES / FETCH while
   *  they're awaiting a reply. */
  #retryPump: ReturnType<typeof setInterval> | null = null

  /** Per-message attempt counters. Bumped each retry-tick; failure
   *  fires when any exceeds `maxAttempts`. */
  #helloAttempts = 0
  #pageRangesAttempts = 0
  #fetchAttempts = 0
  #doneAttempts = 0

  #helloReceived = false
  /** True once we've sent PAGE_RANGES at least once (or decided to
   *  skip the exchange because roots matched). */
  #pageRangesSent = false
  /** True once we've received the peer's PAGE_RANGES. */
  #peerPageRangesReceived = false
  /** Peer has fully completed *their* round — they don't need more
   *  PAGE_RANGES / DATA from us. While false, we keep retransmitting
   *  data-push messages on each tick. */
  #peerDoneReceived = false
  /** Our FETCH was sent and we're awaiting DATA, OR we determined we
   *  needed nothing. `null` = haven't decided yet; `[]` = nothing to
   *  fetch; non-empty array = waiting on DATA reply. */
  #pendingFetch: DiffRange[] | null = null
  #fetchSatisfied = false
  #localDoneSent = false

  #roundComplete = false
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

  #send(m: Message): void {
    this.#transport.send(encodeMessage(m))
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

  #sendPageRanges(): void {
    this.#pageRangesAttempts++
    this.#pageRangesSent = true
    this.#send({ type: MSG_PAGE_RANGES, ranges: this.#deps.localPageRanges() })
  }

  #sendFetch(ranges: DiffRange[]): void {
    this.#fetchAttempts++
    this.#pendingFetch = ranges
    if (ranges.length === 0) {
      // Nothing to fetch — declare our inbound side satisfied without
      // sending FETCH.
      this.#fetchSatisfied = true
      return
    }
    this.#send({ type: MSG_FETCH, ranges })
  }

  /** Shared retry pump. Re-emits any in-flight expectation that
   *  hasn't been satisfied yet; trips `#fail` on exhaustion. */
  #tick(): void {
    if (this.#closed) return
    // Pump keeps ticking past `roundComplete` so we can keep
    // resending data-push messages (PAGE_RANGES, DONE) until peer
    // signals their round is done — without that, B finishing before
    // A receives B's PAGE_RANGES is a hard deadlock. Once peer is
    // done, all retry branches short-circuit on `peerDoneReceived`
    // and the pump becomes a no-op (cleared eventually on `close()`).
    if (this.#peerDoneReceived && this.#roundComplete) return
    const max = this.#deps.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS

    if (!this.#helloReceived && !this.#peerDoneReceived) {
      if (this.#helloAttempts >= max) {
        this.#fail(new SessionError(`hello: exceeded ${max} attempts`))
        return
      }
      this.#sendHello()
      return
    }

    if (this.#pageRangesSent && !this.#peerDoneReceived) {
      if (this.#pageRangesAttempts >= max) {
        this.#fail(new SessionError(`page_ranges: exceeded ${max} attempts`))
        return
      }
      this.#sendPageRanges()
    }

    if (
      this.#pendingFetch !== null &&
      this.#pendingFetch.length > 0 &&
      !this.#fetchSatisfied
    ) {
      if (this.#fetchAttempts >= max) {
        this.#fail(new SessionError(`fetch: exceeded ${max} attempts`))
        return
      }
      this.#fetchAttempts++
      this.#send({ type: MSG_FETCH, ranges: this.#pendingFetch })
    }

    if (this.#localDoneSent && !this.#peerDoneReceived) {
      if (this.#doneAttempts >= max) {
        this.#fail(new SessionError(`done: exceeded ${max} attempts`))
        return
      }
      this.#doneAttempts++
      this.#send({ type: MSG_DONE })
    }
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
          this.#peerDoneReceived = true
          break
        case MSG_ERROR:
          this.#fail(new SessionError(`peer ${m.code}: ${m.msg}`))
          return
        case MSG_PUSH:
          this.#onPush(m)
          break
        case MSG_PAGE_RANGES:
          this.#onPageRanges(m)
          break
        case MSG_FETCH:
          this.#onFetch(m)
          break
        case MSG_DATA:
          this.#onData(m)
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
      // Roots match — no exchange needed.
      this.#pageRangesSent = true
      this.#peerPageRangesReceived = true
      this.#fetchSatisfied = true
      return
    }
    if (!this.#pageRangesSent) this.#sendPageRanges()
  }

  #onPageRanges(m: Message & { type: typeof MSG_PAGE_RANGES }): void {
    const wasReceived = this.#peerPageRangesReceived
    this.#peerPageRangesReceived = true
    const peerRanges: PageRange[] = m.ranges.map((r) => ({
      start: r.start,
      end: r.end,
      hash: r.hash,
    }))
    const need = diff(this.#deps.localPageRanges(), peerRanges)
    if (!wasReceived) {
      // First time: standard FETCH/DATA flow.
      this.#sendFetch(need)
      return
    }
    // Subsequent PAGE_RANGES (peer retried with newer content, e.g.
    // after a mid-round local write on their side). If peer now
    // claims keys we haven't fetched, re-engage: reset
    // fetchSatisfied + roundComplete, send a fresh FETCH. Without
    // this, the second-DATA-dropped race leaves us missing keys
    // peer ships in their newer PAGE_RANGES.
    if (need.length === 0) return // nothing new
    this.#fetchSatisfied = false
    this.#roundComplete = false
    // Note: completion promise has already resolved; we can't
    // un-resolve it. The round-level state still re-engages so
    // the FETCH cycle runs again; the engine sees subsequent
    // onRemoteFact calls and emits to listeners as usual.
    this.#sendFetch(need)
  }

  #onFetch(m: Message & { type: typeof MSG_FETCH }): void {
    const sorted = this.#deps.localKeysSorted()
    const wanted = keysInRanges(sorted, m.ranges)
    const facts: Fact[] = []
    for (const k of wanted) {
      const v = this.#deps.lookupFact(k)
      if (!v) continue
      facts.push({ key: k, relation: v.relation, encodedRow: v.encodedRow })
    }
    const { digest, encoded } = encodePayload(facts)
    this.#send({ type: MSG_DATA, digest, encoded })
  }

  #onData(m: Message & { type: typeof MSG_DATA }): void {
    if (this.#fetchSatisfied) return // duplicate
    const facts = decodePayload(m.digest, m.encoded)
    for (const f of facts) this.#deps.onRemoteFact(f.relation, f.encodedRow)
    this.#fetchSatisfied = true
  }

  #onPush(m: Message & { type: typeof MSG_PUSH }): void {
    const facts = decodePayload(m.digest, m.encoded)
    for (const f of facts) this.#deps.onRemoteFact(f.relation, f.encodedRow)
  }

  #maybeFinish(): void {
    if (
      this.#roundComplete ||
      !this.#peerPageRangesReceived ||
      !this.#fetchSatisfied
    )
      return
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
    // Don't clear the pump yet: peer may still need our PAGE_RANGES
    // / DATA. The pump idles via `peerDoneReceived` until peer signals.
    this.#resolve()
  }

  #clearPump(): void {
    if (this.#retryPump) {
      clearInterval(this.#retryPump)
      this.#retryPump = null
    }
  }

  /** Tear down the session and close the transport. Idempotent. */
  close(): void {
    if (this.#closed) return
    if (this.#roundComplete) {
      this.#closed = true
      this.#clearPump()
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
    this.#clearPump()
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

// Make the unused vars not bite tsc.
void compareHash
