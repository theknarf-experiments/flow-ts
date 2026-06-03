// Level function for MST keys. Matches the canonical
// `merkle-search-tree` Rust crate's default base (16):
//
//   level(hash) = number of leading zero nibbles
//
// Each zero hex digit adds 1; a non-zero digit ends the count.
// Expected fanout per page ≈ 16; expected depth ≈ log₁₆(n).
//
// The level is computed on the *already-hashed* key, so the level
// distribution doesn't depend on user-supplied key contents — only on
// the hash function. For us, keys come from `factKey()` which already
// hashes via WILLIAM3, so we treat the key bytes themselves as the
// digest the level function consumes.

import type { Hash } from '../bab/index.js'

export function levelOf(key: Hash): number {
  let level = 0
  for (let i = 0; i < key.length; i++) {
    const b = key[i]!
    const hi = (b >>> 4) & 0xf
    if (hi !== 0) return level
    level++
    const lo = b & 0xf
    if (lo !== 0) return level
    level++
  }
  return level
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
