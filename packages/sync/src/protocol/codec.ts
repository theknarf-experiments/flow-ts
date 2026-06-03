// CBOR (de)serialisation for sync protocol messages. We use `cborg`
// for the underlying encoder; it round-trips `Uint8Array` natively
// (major type 2 — byte string).
//
// All messages are CBOR arrays starting with the type tag.
// PageRange and DiffRange are encoded as flat tuples of byte
// strings: `[start, end, hash]` and `[start, end]` respectively.

import { decode, encode } from 'cborg'
import {
  MSG_DATA,
  MSG_DONE,
  MSG_ERROR,
  MSG_FETCH,
  MSG_HELLO,
  MSG_PAGE_RANGES,
  MSG_PUSH,
  type Message,
  type WireDiffRange,
  type WirePageRange,
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
    case MSG_PAGE_RANGES:
      return encode([m.type, m.ranges.map((r) => [r.start, r.end, r.hash])])
    case MSG_FETCH:
      return encode([m.type, m.ranges.map((r) => [r.start, r.end])])
    case MSG_DATA:
      return encode([m.type, m.digest, m.encoded])
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
    case MSG_PAGE_RANGES: {
      if (arr.length !== 2) throw new MessageDecodeError('PAGE_RANGES: wrong arity')
      return { type, ranges: assertPageRangeArray(arr[1], 'PAGE_RANGES.ranges') }
    }
    case MSG_FETCH: {
      if (arr.length !== 2) throw new MessageDecodeError('FETCH: wrong arity')
      return { type, ranges: assertDiffRangeArray(arr[1], 'FETCH.ranges') }
    }
    case MSG_DATA: {
      if (arr.length !== 3) throw new MessageDecodeError('DATA: wrong arity')
      return {
        type,
        digest: assertBytes(arr[1], 'DATA.digest'),
        encoded: assertBytes(arr[2], 'DATA.encoded'),
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

function assertPageRangeArray(v: unknown, field: string): WirePageRange[] {
  if (!Array.isArray(v)) throw new MessageDecodeError(`${field}: expected array`)
  return v.map((row, i) => {
    if (!Array.isArray(row) || row.length !== 3) {
      throw new MessageDecodeError(`${field}[${i}]: expected [start, end, hash]`)
    }
    return {
      start: assertBytes(row[0], `${field}[${i}].start`),
      end: assertBytes(row[1], `${field}[${i}].end`),
      hash: assertBytes(row[2], `${field}[${i}].hash`),
    }
  })
}

function assertDiffRangeArray(v: unknown, field: string): WireDiffRange[] {
  if (!Array.isArray(v)) throw new MessageDecodeError(`${field}: expected array`)
  return v.map((row, i) => {
    if (!Array.isArray(row) || row.length !== 2) {
      throw new MessageDecodeError(`${field}[${i}]: expected [start, end]`)
    }
    return {
      start: assertBytes(row[0], `${field}[${i}].start`),
      end: assertBytes(row[1], `${field}[${i}].end`),
    }
  })
}
