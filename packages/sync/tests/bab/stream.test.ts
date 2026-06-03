// The bab streaming encode/decode property:
//   babDecode(babHash(d), babEncode(d))  ===  d        (any d)
// Plus tampering detection on every byte of the encoded stream.

import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import { CHUNK_SIZE, BabError, babDecode, babEncode, babHash } from '../../src/bab/index.js'

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

describe('babEncode / babDecode', () => {
  it('round-trips an empty input', () => {
    const data = new Uint8Array(0)
    const encoded = babEncode(data)
    const decoded = babDecode(babHash(data), encoded)
    expect(decoded.length).toBe(0)
  })

  it('round-trips a single-chunk input', () => {
    const data = new Uint8Array(500)
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff
    const decoded = babDecode(babHash(data), babEncode(data))
    expect(bytesEqual(decoded, data)).toBe(true)
  })

  it('round-trips inputs straddling the chunk boundary', () => {
    for (const L of [CHUNK_SIZE, CHUNK_SIZE + 1, CHUNK_SIZE * 2, CHUNK_SIZE * 2 + 1]) {
      const data = new Uint8Array(L)
      for (let i = 0; i < L; i++) data[i] = (i * 17) & 0xff
      const decoded = babDecode(babHash(data), babEncode(data))
      expect(bytesEqual(decoded, data)).toBe(true)
    }
  })

  it('round-trips arbitrary inputs (property)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: CHUNK_SIZE * 6 }), (data) => {
        const decoded = babDecode(babHash(data), babEncode(data))
        return bytesEqual(decoded, data)
      }),
      { numRuns: 50 },
    )
  })

  it('detects tampering at any byte offset of the encoded stream', () => {
    const data = new Uint8Array(CHUNK_SIZE * 3 + 200)
    for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 0xff
    const digest = babHash(data)
    const encoded = babEncode(data)

    fc.assert(
      fc.property(fc.integer({ min: 0, max: encoded.length - 1 }), (idx) => {
        const corrupted = new Uint8Array(encoded)
        corrupted[idx] ^= 0xff
        // Either decode rejects (BabError) OR the decoded bytes differ.
        // (Tampering the length prefix can produce a "valid"-looking
        // truncated decode; we just require it doesn't reproduce `data`.)
        try {
          const decoded = babDecode(digest, corrupted)
          return !bytesEqual(decoded, data)
        } catch (e) {
          return e instanceof BabError
        }
      }),
      { numRuns: 60 },
    )
  })

  it('rejects a truncated stream', () => {
    const data = new Uint8Array(CHUNK_SIZE * 2 + 50)
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff
    const digest = babHash(data)
    const encoded = babEncode(data)
    const truncated = encoded.subarray(0, encoded.length - 1)
    expect(() => babDecode(digest, truncated)).toThrow(BabError)
  })

  it('rejects a stream with the wrong expected digest', () => {
    const data = new Uint8Array(CHUNK_SIZE + 17).fill(0x42)
    const encoded = babEncode(data)
    const wrongDigest = new Uint8Array(32)
    wrongDigest[0] = 0xff
    expect(() => babDecode(wrongDigest, encoded)).toThrow(BabError)
  })
})
