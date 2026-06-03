// `DATA` payload format. A list of (key, relation, encodedRow)
// tuples, CBOR-encoded then bab-encoded. The receiver bab-decodes
// the stream (verifying byte integrity against the announced
// digest), CBOR-decodes the array, and re-derives each key from
// (relation, encodedRow) to ensure the payload structure matches
// what the keys claim. A malicious sender can therefore only ship
// keys whose contents hash to the same key — not arbitrary
// (key, junk) pairs.

import { decode as cborDecode, encode as cborEncode } from 'cborg'
import { babDecode, babEncode, babHash, type Hash } from '../bab/index.js'
import { bytesEqual } from '../mst/index.js'

export interface Fact {
  key: Hash
  relation: string
  encodedRow: string
}

/** Canonical key for a fact: `bab(u32_be(rel.len) ‖ rel ‖ u32_be(row.len) ‖ row)`. */
export function factKey(relation: string, encodedRow: string): Hash {
  const enc = new TextEncoder()
  const relBytes = enc.encode(relation)
  const rowBytes = enc.encode(encodedRow)
  const buf = new Uint8Array(4 + relBytes.length + 4 + rowBytes.length)
  const view = new DataView(buf.buffer, buf.byteOffset)
  view.setUint32(0, relBytes.length, false)
  buf.set(relBytes, 4)
  view.setUint32(4 + relBytes.length, rowBytes.length, false)
  buf.set(rowBytes, 8 + relBytes.length)
  return babHash(buf)
}

export interface EncodedPayload {
  digest: Hash
  encoded: Uint8Array
}

export function encodePayload(facts: Fact[]): EncodedPayload {
  const arr = facts.map((f) => [f.key, f.relation, f.encodedRow])
  const cborBytes = cborEncode(arr)
  const digest = babHash(cborBytes)
  const encoded = babEncode(cborBytes)
  return { digest, encoded }
}

export class PayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PayloadError'
  }
}

export function decodePayload(digest: Hash, encoded: Uint8Array): Fact[] {
  const cborBytes = babDecode(digest, encoded)
  const arr = cborDecode(cborBytes) as unknown
  if (!Array.isArray(arr)) throw new PayloadError('payload: expected array')
  return arr.map((item, i) => {
    if (!Array.isArray(item) || item.length !== 3) {
      throw new PayloadError(`payload[${i}]: expected [key, rel, row]`)
    }
    const [key, relation, encodedRow] = item
    if (!(key instanceof Uint8Array)) throw new PayloadError(`payload[${i}].key: expected bytes`)
    if (typeof relation !== 'string') {
      throw new PayloadError(`payload[${i}].relation: expected string`)
    }
    if (typeof encodedRow !== 'string') {
      throw new PayloadError(`payload[${i}].encodedRow: expected string`)
    }
    const computed = factKey(relation, encodedRow)
    if (!bytesEqual(key, computed)) {
      throw new PayloadError(`payload[${i}].key: mismatch (sender claimed a key not derived from its bytes)`)
    }
    return { key, relation, encodedRow }
  })
}
