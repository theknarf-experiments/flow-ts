// KAT vectors from the `bab_rs` reference implementation
// (codeberg.org/worm-blossom/bab_rs, file `william3vectors.txt`).
// These are the source of truth for "is our WILLIAM3 port byte-exact?".

import { describe, expect, it } from 'vitest'
import { babHash } from '../../src/bab/index.js'
import { hashChunk, hashInner } from '../../src/bab/william3.js'

function hex(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) {
    const x = b[i]!
    s += (x >>> 4).toString(16) + (x & 0xf).toString(16)
  }
  return s
}

/** Convert a decimal-array vector (as it appears in
 *  `william3vectors.txt`) to its hex string. */
function decToHex(...bytes: number[]): string {
  return hex(new Uint8Array(bytes))
}

describe('WILLIAM3 KAT vectors (oracle: bab_rs)', () => {
  it('test 1: empty input', () => {
    const expected = decToHex(
      59, 99, 143, 200, 242, 251, 104, 65, 131, 37, 163, 107, 71, 24, 255, 176,
      125, 228, 87, 172, 48, 19, 147, 168, 69, 70, 106, 121, 238, 163, 40, 107,
    )
    expect(hex(babHash(new Uint8Array(0)))).toBe(expected)
  })

  it('test 2: one 0x00 byte', () => {
    const expected = decToHex(
      45, 15, 76, 38, 148, 217, 210, 239, 109, 30, 192, 102, 72, 242, 255, 71,
      227, 171, 85, 143, 59, 195, 232, 222, 3, 222, 108, 10, 143, 125, 146, 9,
    )
    const data = new Uint8Array([0x00])
    expect(hex(babHash(data))).toBe(expected)
  })

  it('test 3: 0x01 × 1024 (exact one-chunk boundary)', () => {
    const expected = decToHex(
      242, 177, 126, 219, 185, 216, 149, 65, 56, 20, 89, 207, 65, 27, 7, 116,
      80, 61, 55, 190, 199, 61, 17, 28, 25, 234, 232, 117, 202, 92, 25, 93,
    )
    const data = new Uint8Array(1024).fill(0x01)
    expect(hex(babHash(data))).toBe(expected)
  })

  it('test 4: 0x02 × 1025 (smallest two-chunk input)', () => {
    const expected = decToHex(
      219, 231, 162, 187, 226, 242, 23, 168, 73, 98, 18, 128, 177, 35, 87, 172,
      234, 183, 208, 0, 137, 58, 57, 195, 180, 21, 221, 196, 108, 142, 201, 212,
    )
    const data = new Uint8Array(1025).fill(0x02)
    expect(hex(babHash(data))).toBe(expected)
  })

  it('test 5: 0x03 × 4097 (multi-chunk, non-power-of-2 tree)', () => {
    const expected = decToHex(
      213, 158, 45, 108, 119, 139, 160, 205, 101, 51, 60, 72, 4, 138, 223, 12,
      139, 139, 84, 43, 68, 123, 194, 98, 166, 165, 16, 84, 40, 125, 205, 189,
    )
    const data = new Uint8Array(4097).fill(0x03)
    expect(hex(babHash(data))).toBe(expected)
  })

  // The chunk/inner primitives are exposed so the protocol layer
  // (DATA payload verification) can also be black-box tested
  // independently of full-tree assembly.
  it('hashChunk(empty, root) equals babHash(empty)', () => {
    expect(hex(hashChunk(new Uint8Array(0), true))).toBe(hex(babHash(new Uint8Array(0))))
  })

  it('hashChunk(64 bytes, root) equals babHash(same)', () => {
    const data = new Uint8Array(64)
    for (let i = 0; i < 64; i++) data[i] = i & 0xff
    expect(hex(hashChunk(data, true))).toBe(hex(babHash(data)))
  })

  it('hashInner is sensitive to length parameter (counter `t`)', () => {
    const left = new Uint8Array(32).fill(0x11)
    const right = new Uint8Array(32).fill(0x22)
    const a = hashInner(left, right, 100, false)
    const b = hashInner(left, right, 200, false)
    expect(hex(a)).not.toBe(hex(b))
  })

  it('hashInner is sensitive to isRoot (ROOT flag)', () => {
    const left = new Uint8Array(32).fill(0xaa)
    const right = new Uint8Array(32).fill(0xbb)
    const a = hashInner(left, right, 1024, false)
    const b = hashInner(left, right, 1024, true)
    expect(hex(a)).not.toBe(hex(b))
  })
})
