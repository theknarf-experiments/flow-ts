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
/** Range-diff initiation: sender claims their view of `[lo, hi)` has
 *  this digest and contains this many keys. */
export const MSG_RANGE_DIFF = 0x08
/** Receiver's range view matches sender's; the range is in sync. */
export const MSG_RANGE_MATCH = 0x09
/** Receiver asks sender to bisect at `mid` and try again. */
export const MSG_RANGE_SPLIT = 0x0a
/** Receiver's view of the range, as a bab-encoded fact payload.
 *  Sender applies (deduping); the symmetric walk from the *other*
 *  side will discover anything the receiver was missing. */
export const MSG_RANGE_DATA = 0x0b

/** A range is `[lo, hi)`. `hi === null` represents +∞ (everything from
 *  `lo` upward). The full key space is `[ZERO_HASH, null)`. */
export type Bound = Hash | null

export type Message =
  | { type: typeof MSG_HELLO; version: number; replica: Uint8Array; root: Hash }
  | { type: typeof MSG_DONE }
  | { type: typeof MSG_ERROR; code: number; msg: string }
  | { type: typeof MSG_PUSH; digest: Hash; encoded: Uint8Array }
  | { type: typeof MSG_RANGE_DIFF; lo: Hash; hi: Bound; digest: Hash; count: number }
  | { type: typeof MSG_RANGE_MATCH; lo: Hash; hi: Bound }
  | { type: typeof MSG_RANGE_SPLIT; lo: Hash; mid: Hash; hi: Bound }
  | { type: typeof MSG_RANGE_DATA; lo: Hash; hi: Bound; digest: Hash; encoded: Uint8Array }

export const PROTOCOL_VERSION = 2
