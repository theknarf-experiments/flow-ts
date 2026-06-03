// Wire-level message types. Encoded as CBOR-tagged arrays so an
// unknown tag at the head can be rejected fast without parsing the
// rest. See `codec.ts` for the (de)serialisation.

import type { Hash } from '../bab/index.js'

export const MSG_HELLO = 0x01
export const MSG_DONE = 0x05
export const MSG_ERROR = 0x06
/** Post-round live update: one or more facts the sender has that the
 *  receiver might want. Bab-encoded CBOR array of (key, rel, row)
 *  tuples. No ack; receiver dedups against its own MST. */
export const MSG_PUSH = 0x07
/** Sender's serialised page ranges from its MST: one
 *  `[start, end, hash]` triple per page, pre-order DFS. Receiver
 *  runs a local `diff(localRanges, theseRanges)` to compute the key
 *  ranges it needs to fetch, then sends FETCH. */
export const MSG_PAGE_RANGES = 0x0c
/** Receiver asks sender for all facts whose key falls in any of the
 *  listed inclusive ranges. */
export const MSG_FETCH = 0x0d
/** Sender's response to FETCH: bab-encoded CBOR array of (key, rel,
 *  encodedRow) tuples covering the requested ranges. */
export const MSG_DATA = 0x0e

export interface WirePageRange {
  start: Hash
  end: Hash
  hash: Hash
}

export interface WireDiffRange {
  start: Hash
  end: Hash
}

export type Message =
  | { type: typeof MSG_HELLO; version: number; replica: Uint8Array; root: Hash }
  | { type: typeof MSG_DONE }
  | { type: typeof MSG_ERROR; code: number; msg: string }
  | { type: typeof MSG_PUSH; digest: Hash; encoded: Uint8Array }
  | { type: typeof MSG_PAGE_RANGES; ranges: WirePageRange[] }
  | { type: typeof MSG_FETCH; ranges: WireDiffRange[] }
  | { type: typeof MSG_DATA; digest: Hash; encoded: Uint8Array }

export const PROTOCOL_VERSION = 3
