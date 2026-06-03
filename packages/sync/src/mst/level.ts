// Per the design doc:
//   level(key) = floor(leading_zero_bits(key) / 2)
// Base-4 ⇒ expected fanout 4, depth ≈ log_4(n).

import type { Hash } from '../bab/index.js'

export function levelOf(key: Hash): number {
  let zeros = 0
  for (let i = 0; i < key.length; i++) {
    const b = key[i]!
    if (b === 0) {
      zeros += 8
      continue
    }
    let mask = 0x80
    while ((b & mask) === 0) {
      zeros++
      mask >>>= 1
    }
    break
  }
  return zeros >> 1
}

/** Lexicographic byte comparison of two 32-byte hashes.
 *  Returns -1 / 0 / +1. */
export function compareHash(a: Hash, b: Hash): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const av = a[i]!
    const bv = b[i]!
    if (av !== bv) return av < bv ? -1 : 1
  }
  return a.length - b.length
}

export function bytesEqual(a: Hash, b: Hash): boolean {
  return compareHash(a, b) === 0
}

export function toHex(h: Hash): string {
  let s = ''
  for (let i = 0; i < h.length; i++) {
    const b = h[i]!
    s += (b >>> 4).toString(16) + (b & 0xf).toString(16)
  }
  return s
}

export function fromHex(s: string): Hash {
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.substring(i * 2, i * 2 + 2), 16)
  }
  return out
}
