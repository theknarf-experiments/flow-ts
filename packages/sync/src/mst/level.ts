// Level function for MST keys. Faithful port of the canonical
// `merkle-search-tree` Rust crate (default base 16). The semantics
// are subtle and the obvious "count leading zero nibbles" reading
// is WRONG — it concentrates level-≥1 keys at the low end of byte
// order, which then never split level-0 pages, producing O(n²)
// inserts. The correct semantics, byte-by-byte:
//
//   * byte == 0          → level += 2 (both nibbles zero), continue.
//   * byte ≡ 0 mod 16    → return level + 1 (low nibble zero, high
//                          nibble non-zero — i.e. 0x10, 0x20, …, 0xF0).
//   * otherwise          → return level.
//
// This spreads level-≥1 keys across the byte range
// (0x10, 0x20, ..., 0xF0, 0x100, 0x110, ...) interleaved with level-0
// keys, so they naturally split level-0 pages on insertion.
//
// The level is computed on the *already-hashed* key, so the level
// distribution doesn't depend on user-supplied key contents — only
// on the hash function. For us, keys come from `factKey()` which
// already hashes via WILLIAM3, so we treat the key bytes themselves
// as the digest the level function consumes.

import type { Hash } from '../bab/index.js'

export function levelOf(key: Hash): number {
  let level = 0
  for (let i = 0; i < key.length; i++) {
    const b = key[i]!
    if (b === 0) {
      level += 2
      continue
    }
    if ((b & 0x0f) === 0) return level + 1
    return level
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
