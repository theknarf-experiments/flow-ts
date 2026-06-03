// Range-based set reconciliation over 32-byte hash keys. The key
// space is treated as a 256-bit unsigned integer interval and
// bisected recursively. Each side computes a digest for its keys in
// a given range; if digests match, the range is in sync and the
// subtree is skipped entirely. If they differ, the range is split
// at its bit-midpoint and the two halves are reconciled in turn.
// Base case: ≤ MAX_RANGE_KEYS on at least one side → enumerate.
//
// Bandwidth: O(diff + log n). Concretely, for a tree of n keys with
// d differences, the wire cost is O(d) keys plus O(log n) per
// non-matching range walked (~32 bytes per range message).
//
// This is the engine the protocol's reconcile phase rides on — see
// `src/protocol/range-session.ts` for the message-driven driver.

import { babHash, HASH_LEN, type Hash } from '../bab/index.js'
import { compareHash } from './level.js'

export const HASH_BITS = HASH_LEN * 8

/** Canonical lo bound (all-zero hash, inclusive). */
export const ZERO_HASH: Hash = new Uint8Array(HASH_LEN)

/** Canonical hi bound (one-past-max, represented as a marker — see
 *  `inRange`). We treat hi as exclusive over 256-bit values, so the
 *  "everything" range is [ZERO_HASH, MAX_HASH+1). We model that
 *  by using a 33-byte hi where the first byte is 0x01 followed by
 *  32 zero bytes, but for simplicity we use a normal 32-byte
 *  ALL_ONES and treat the full range as a special case in `inRange`.
 */
export const ALL_ONES: Hash = (() => {
  const h = new Uint8Array(HASH_LEN)
  h.fill(0xff)
  return h
})()

/** Indicate the unbounded "everything" range with a sentinel hi
 *  value. Internally any value > MAX_HASH (i.e. one-past-max) is
 *  represented as `null` so we don't need 33-byte arithmetic. */
export type Bound = Hash | null // null = +∞

/** True iff `k` ∈ [lo, hi) treating null hi as +∞. */
export function inRange(k: Hash, lo: Hash, hi: Bound): boolean {
  if (compareHash(k, lo) < 0) return false
  if (hi === null) return true
  return compareHash(k, hi) < 0
}

/** Find the index of the first key >= `bound` in a sorted list. */
export function lowerBound(sortedKeys: Hash[], bound: Hash): number {
  let lo = 0
  let hi = sortedKeys.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (compareHash(sortedKeys[mid]!, bound) < 0) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Slice the sorted key list to those in `[lo, hi)`. Returns the
 *  slice and its `[start, end)` indices in the original. */
export function sliceRange(
  sortedKeys: Hash[],
  lo: Hash,
  hi: Bound,
): { keys: Hash[]; start: number; end: number } {
  const start = lowerBound(sortedKeys, lo)
  const end = hi === null ? sortedKeys.length : lowerBound(sortedKeys, hi)
  return { keys: sortedKeys.slice(start, end), start, end }
}

/** Canonical digest of a range. Defined as `babHash(u32_le(count) ‖ k0 ‖ k1 ‖ …)`
 *  with keys in sorted order. Two peers with identical keys in the
 *  range produce byte-identical digests. */
export function rangeDigest(sortedKeysInRange: Hash[]): Hash {
  const count = sortedKeysInRange.length
  const buf = new Uint8Array(4 + count * HASH_LEN)
  const view = new DataView(buf.buffer, buf.byteOffset, 4)
  view.setUint32(0, count, true)
  for (let i = 0; i < count; i++) buf.set(sortedKeysInRange[i]!, 4 + i * HASH_LEN)
  return babHash(buf)
}

/** Convenience: digest + count for a range against an already-sorted list. */
export function rangeSummary(
  sortedKeys: Hash[],
  lo: Hash,
  hi: Bound,
): { digest: Hash; count: number } {
  const { keys } = sliceRange(sortedKeys, lo, hi)
  return { digest: rangeDigest(keys), count: keys.length }
}

/** Bisect a range. Returns the bit-midpoint key, or null if the
 *  range can't be split further (lo and hi differ by exactly one). */
export function bisect(lo: Hash, hi: Bound): Hash | null {
  // Compute mid = (lo + hi) / 2 in 256-bit unsigned arithmetic.
  // For hi = null (+∞), use mid = (lo + ALL_ONES + 1) / 2 = (lo + 2^256) / 2.
  // Equivalently: mid = (lo >> 1) + (2^255).
  const mid = new Uint8Array(HASH_LEN)
  if (hi === null) {
    // mid = (lo + (MAX+1)) / 2 = lo/2 + 2^255 = lo/2 with top bit set.
    let carry = 0
    for (let i = 0; i < HASH_LEN; i++) {
      const v = lo[i]! | (carry << 8)
      mid[i] = v >>> 1
      carry = v & 1
    }
    mid[0] = mid[0]! | 0x80 // set the high bit (adds 2^255)
  } else {
    // mid = (lo + hi) / 2. Sum 32 bytes pairwise with carry.
    let carry = 0
    const sum = new Uint8Array(HASH_LEN + 1)
    for (let i = HASH_LEN - 1; i >= 0; i--) {
      const s = lo[i]! + hi[i]! + carry
      sum[i + 1] = s & 0xff
      carry = (s >> 8) & 1
    }
    sum[0] = carry
    // Right-shift sum by 1.
    let bit = 0
    for (let i = 0; i < HASH_LEN + 1; i++) {
      const v = sum[i]! | (bit << 8)
      sum[i] = v >>> 1
      bit = v & 1
    }
    // Drop the top byte (the now-shifted carry).
    for (let i = 0; i < HASH_LEN; i++) mid[i] = sum[i + 1]!
  }
  // If mid <= lo or mid >= hi, the range can't be split further.
  if (compareHash(mid, lo) <= 0) return null
  if (hi !== null && compareHash(mid, hi) >= 0) return null
  return mid
}

/** True iff lo == hi-1 (i.e. the range is a single hash value).
 *  Used to short-circuit further bisection. */
export function isAtomicRange(lo: Hash, hi: Bound): boolean {
  return bisect(lo, hi) === null
}
