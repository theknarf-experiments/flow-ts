// Wire-level message types. Encoded as CBOR-tagged arrays so an
// unknown tag at the head can be rejected fast without parsing the
// rest. See `codec.ts` for the (de)serialisation.

import type { Hash } from '../bab/index.js'

export const MSG_HELLO = 0x01
export const MSG_KEYS = 0x02
export const MSG_FETCH = 0x03
export const MSG_DATA = 0x04
export const MSG_DONE = 0x05
export const MSG_ERROR = 0x06
/** Post-round live update: one or more facts the sender has that the
 *  receiver might want. Same payload shape as DATA — bab-encoded
 *  CBOR array of (key, rel, row) tuples. No ack; receiver dedups
 *  against its own MST. */
export const MSG_PUSH = 0x07

export type Message =
  | { type: typeof MSG_HELLO; version: number; replica: Uint8Array; root: Hash }
  | { type: typeof MSG_KEYS; keys: Hash[] }
  | { type: typeof MSG_FETCH; keys: Hash[] }
  | { type: typeof MSG_DATA; digest: Hash; encoded: Uint8Array }
  | { type: typeof MSG_DONE }
  | { type: typeof MSG_ERROR; code: number; msg: string }
  | { type: typeof MSG_PUSH; digest: Hash; encoded: Uint8Array }

export const PROTOCOL_VERSION = 1
