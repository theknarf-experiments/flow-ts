// Merkle Search Tree over 32-byte keys (typically bab-hash digests
// of facts). Structure is fully determined by the key set + level
// function, so two replicas with identical key sets produce
// byte-identical trees and matching root digests.
//
// v1 strategy: maintain the keys in a Set; rebuild the canonical tree
// lazily when the digest or structure is observed. Rebuild is
// O(n) per call, which is fine for the EDB sizes the sync engine
// targets in v1 (single-digit thousands of facts). Incremental
// O(log n) insert lands in v2 if we need it.

import { HASH_LEN, babHash, type Hash } from '../bab/index.js'
import { bytesEqual, compareHash, levelOf, toHex } from './level.js'

export interface MstNode {
  level: number
  /** Sorted ascending by `compareHash`; all entries have `levelOf(k) === level`. */
  entries: Hash[]
  /** `entries.length + 1` children. `children[i]` covers the key range
   *  strictly between entries[i-1] and entries[i] (with -∞ and +∞ at
   *  the boundaries). Each child node has `level < this.level`. */
  children: (MstNode | null)[]
  /** Cached node digest. */
  digest: Hash
}

/** Sentinel for the empty tree: the digest of no keys at all.
 *  33 zero bytes hashed; can't collide with any non-empty node digest
 *  (those are prefixed with 0x10). The exact value is internal —
 *  only equality matters. */
export const EMPTY_DIGEST: Hash = babHash(new Uint8Array(33))

/** A node digest distinguishes empty/leaf/inner via a domain byte:
 *    0x10 = MST node (any level)
 *  followed by:  u8 level || u32_be entry_count
 *                || (for each i: entry_i || child_i.digest)
 *                || child_last.digest
 *  Empty children contribute `EMPTY_DIGEST`.
 */
function nodeDigest(level: number, entries: Hash[], children: (MstNode | null)[]): Hash {
  const n = entries.length
  const buf = new Uint8Array(1 + 1 + 4 + n * (HASH_LEN + HASH_LEN) + HASH_LEN)
  let off = 0
  buf[off++] = 0x10
  buf[off++] = level & 0xff
  const view = new DataView(buf.buffer, buf.byteOffset)
  view.setUint32(off, n, false)
  off += 4
  for (let i = 0; i < n; i++) {
    buf.set(entries[i]!, off)
    off += HASH_LEN
    buf.set(children[i] ? children[i]!.digest : EMPTY_DIGEST, off)
    off += HASH_LEN
  }
  buf.set(children[n] ? children[n]!.digest : EMPTY_DIGEST, off)
  return babHash(buf)
}

/** Build the canonical MST node for a sorted, deduplicated key range. */
function buildFromSorted(keys: Hash[]): MstNode | null {
  if (keys.length === 0) return null
  // Find the maximum level in this range.
  let maxLevel = -1
  for (const k of keys) {
    const lvl = levelOf(k)
    if (lvl > maxLevel) maxLevel = lvl
  }
  // Partition: top-level keys → entries, in-between buckets → children.
  const entries: Hash[] = []
  const childBuckets: Hash[][] = [[]]
  for (const k of keys) {
    if (levelOf(k) === maxLevel) {
      entries.push(k)
      childBuckets.push([])
    } else {
      childBuckets[childBuckets.length - 1]!.push(k)
    }
  }
  const children = childBuckets.map(buildFromSorted)
  return { level: maxLevel, entries, children, digest: nodeDigest(maxLevel, entries, children) }
}

export class Mst {
  /** Hex-encoded keys for Set deduplication. */
  #hexKeys = new Set<string>()
  /** Cached canonical tree. Invalidated on any insert. */
  #cached: MstNode | null | undefined = undefined // `undefined` = not yet computed

  /** Insert a key. Idempotent — duplicates are dropped. Returns true
   *  if the key was new (the tree changed). */
  insert(key: Hash): boolean {
    if (key.length !== HASH_LEN) throw new Error(`MST key must be ${HASH_LEN} bytes`)
    const hex = toHex(key)
    if (this.#hexKeys.has(hex)) return false
    this.#hexKeys.add(hex)
    this.#cached = undefined
    return true
  }

  /** Total key count. */
  get size(): number {
    return this.#hexKeys.size
  }

  /** Iterate keys (no defined order). */
  *keys(): IterableIterator<Hash> {
    for (const hex of this.#hexKeys) {
      const out = new Uint8Array(HASH_LEN)
      for (let i = 0; i < HASH_LEN; i++) {
        out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16)
      }
      yield out
    }
  }

  /** Compute the canonical tree (cached). `null` for an empty tree. */
  root(): MstNode | null {
    if (this.#cached === undefined) {
      const sorted: Hash[] = []
      for (const hex of this.#hexKeys) {
        const out = new Uint8Array(HASH_LEN)
        for (let i = 0; i < HASH_LEN; i++) {
          out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16)
        }
        sorted.push(out)
      }
      sorted.sort(compareHash)
      this.#cached = buildFromSorted(sorted)
    }
    return this.#cached
  }

  /** Root digest. `EMPTY_DIGEST` for an empty tree. */
  rootDigest(): Hash {
    const r = this.root()
    return r ? r.digest : EMPTY_DIGEST
  }

  /** True iff the given key is in the tree. */
  has(key: Hash): boolean {
    return this.#hexKeys.has(toHex(key))
  }
}

/** Walk a node, yielding every key it covers in sorted order. */
export function* collectKeys(node: MstNode | null): IterableIterator<Hash> {
  if (!node) return
  for (let i = 0; i < node.entries.length; i++) {
    yield* collectKeys(node.children[i] ?? null)
    yield node.entries[i]!
  }
  yield* collectKeys(node.children[node.entries.length] ?? null)
}

export { bytesEqual, compareHash, levelOf } from './level.js'
