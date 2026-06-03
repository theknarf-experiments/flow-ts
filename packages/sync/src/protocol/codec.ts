// CBOR (de)serialisation for sync protocol messages. We use `cborg`
// for the underlying encoder; it round-trips `Uint8Array` natively
// (major type 2 — byte string).
//
// All messages are CBOR arrays starting with the type tag. Keeps
// dispatch cheap and the encoding self-describing without per-message
// schema tables. `null` is used wherever a range's `hi` bound is +∞.

import { decode, encode } from 'cborg'
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
} from './messages.js'

export function encodeMessage(m: Message): Uint8Array {
  switch (m.type) {
    case MSG_HELLO:
      return encode([m.type, m.version, m.replica, m.root])
    case MSG_DONE:
      return encode([m.type])
    case MSG_ERROR:
      return encode([m.type, m.code, m.msg])
    case MSG_PUSH:
      return encode([m.type, m.digest, m.encoded])
    case MSG_RANGE_DIFF:
      return encode([m.type, m.lo, m.hi, m.digest, m.count])
    case MSG_RANGE_MATCH:
      return encode([m.type, m.lo, m.hi])
    case MSG_RANGE_SPLIT:
      return encode([m.type, m.lo, m.mid, m.hi])
    case MSG_RANGE_DATA:
      return encode([m.type, m.lo, m.hi, m.digest, m.encoded])
  }
}

export class MessageDecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MessageDecodeError'
  }
}

export function decodeMessage(buf: Uint8Array): Message {
  let arr: unknown
  try {
    arr = decode(buf)
  } catch (e) {
    throw new MessageDecodeError(`cbor decode failed: ${(e as Error).message}`)
  }
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new MessageDecodeError('expected CBOR array')
  }
  const type = arr[0] as number
  switch (type) {
    case MSG_HELLO: {
      if (arr.length !== 4) throw new MessageDecodeError('HELLO: wrong arity')
      return {
        type,
        version: assertNumber(arr[1], 'HELLO.version'),
        replica: assertBytes(arr[2], 'HELLO.replica'),
        root: assertBytes(arr[3], 'HELLO.root'),
      }
    }
    case MSG_DONE: {
      if (arr.length !== 1) throw new MessageDecodeError('DONE: wrong arity')
      return { type }
    }
    case MSG_ERROR: {
      if (arr.length !== 3) throw new MessageDecodeError('ERROR: wrong arity')
      return {
        type,
        code: assertNumber(arr[1], 'ERROR.code'),
        msg: assertString(arr[2], 'ERROR.msg'),
      }
    }
    case MSG_PUSH: {
      if (arr.length !== 3) throw new MessageDecodeError('PUSH: wrong arity')
      return {
        type,
        digest: assertBytes(arr[1], 'PUSH.digest'),
        encoded: assertBytes(arr[2], 'PUSH.encoded'),
      }
    }
    case MSG_RANGE_DIFF: {
      if (arr.length !== 5) throw new MessageDecodeError('RANGE_DIFF: wrong arity')
      return {
        type,
        lo: assertBytes(arr[1], 'RANGE_DIFF.lo'),
        hi: assertBound(arr[2], 'RANGE_DIFF.hi'),
        digest: assertBytes(arr[3], 'RANGE_DIFF.digest'),
        count: assertNumber(arr[4], 'RANGE_DIFF.count'),
      }
    }
    case MSG_RANGE_MATCH: {
      if (arr.length !== 3) throw new MessageDecodeError('RANGE_MATCH: wrong arity')
      return {
        type,
        lo: assertBytes(arr[1], 'RANGE_MATCH.lo'),
        hi: assertBound(arr[2], 'RANGE_MATCH.hi'),
      }
    }
    case MSG_RANGE_SPLIT: {
      if (arr.length !== 4) throw new MessageDecodeError('RANGE_SPLIT: wrong arity')
      return {
        type,
        lo: assertBytes(arr[1], 'RANGE_SPLIT.lo'),
        mid: assertBytes(arr[2], 'RANGE_SPLIT.mid'),
        hi: assertBound(arr[3], 'RANGE_SPLIT.hi'),
      }
    }
    case MSG_RANGE_DATA: {
      if (arr.length !== 5) throw new MessageDecodeError('RANGE_DATA: wrong arity')
      return {
        type,
        lo: assertBytes(arr[1], 'RANGE_DATA.lo'),
        hi: assertBound(arr[2], 'RANGE_DATA.hi'),
        digest: assertBytes(arr[3], 'RANGE_DATA.digest'),
        encoded: assertBytes(arr[4], 'RANGE_DATA.encoded'),
      }
    }
    default:
      throw new MessageDecodeError(`unknown message type: ${type}`)
  }
}

function assertNumber(v: unknown, field: string): number {
  if (typeof v !== 'number') throw new MessageDecodeError(`${field}: expected number`)
  return v
}

function assertString(v: unknown, field: string): string {
  if (typeof v !== 'string') throw new MessageDecodeError(`${field}: expected string`)
  return v
}

function assertBytes(v: unknown, field: string): Uint8Array {
  if (!(v instanceof Uint8Array)) {
    throw new MessageDecodeError(`${field}: expected bytes`)
  }
  return v
}

function assertBound(v: unknown, field: string): Bound {
  if (v === null) return null
  return assertBytes(v, field)
}
