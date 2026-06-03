// Merkle Search Tree. Public `Mst` class wraps a `Page` root and
// supports incremental upsert (O(log n) expected per insert, amortised
// over hash invalidation). Page subtree digests are cached and
// invalidated only along the modified path.
//
// Tree structure and digest layout match the canonical Rust
// `merkle-search-tree` crate; see `page.ts` for the building blocks.

import { babHash, HASH_LEN, type Hash } from '../bab/index.js'
import { compareHash, levelOf, toHex } from './level.js'
import {
  Page,
  collectKeys as pageCollectKeys,
  upsert as pageUpsert,
  type MstNode,
} from './page.js'

/** Sentinel for the empty tree: the digest of no keys at all.
 *  64 zero bytes hashed (twice the key length). Distinct from any
 *  non-empty page digest because non-empty pages always commit to
 *  at least one key. */
export const EMPTY_DIGEST: Hash = babHash(new Uint8Array(HASH_LEN * 2))

export class Mst {
  /** Hex-encoded keys for quick `has()` / `size`. The Page tree is
   *  the authoritative store; this Set is a lookup accelerant. */
  #hexKeys = new Set<string>()
  /** Root page. Starts as an empty placeholder at level 0; on first
   *  insertion that needs a higher level, we replace via
   *  `insertIntermediate` semantics in `insert()`. */
  #root: Page = new Page(0, [])

  /** Insert a key. Idempotent — duplicates are no-ops. Returns true
   *  iff the key was new (the tree changed). */
  insert(key: Hash): boolean {
    if (key.length !== HASH_LEN) throw new Error(`MST key must be ${HASH_LEN} bytes`)
    const hex = toHex(key)
    if (this.#hexKeys.has(hex)) return false
    this.#hexKeys.add(hex)

    const level = levelOf(key)
    if (this.#root.isEmpty()) {
      // Bootstrap: empty root → make a single-node page at the key's level.
      this.#root = new Page(level, [{ key, ltPointer: null }])
      return true
    }
    const r = pageUpsert(this.#root, key, level)
    if (r.kind === 'insertIntermediate') {
      // The key is at a higher level than the current root; promote
      // a new root page containing just this key, with the old root
      // hanging off the appropriate side.
      const old = this.#root
      const isLeft = compareHash(key, leftmostKey(old)) < 0
      const newNode: MstNode = {
        key,
        ltPointer: isLeft ? null : old,
      }
      const newHigh: Page | null = isLeft ? old : null
      this.#root = new Page(level, [newNode], newHigh)
    }
    return true
  }

  /** Total key count. */
  get size(): number {
    return this.#hexKeys.size
  }

  /** Iterate all keys in ascending order. */
  *keys(): IterableIterator<Hash> {
    yield* pageCollectKeys(this.#root)
  }

  /** Root page. `null` if the tree is empty. */
  root(): Page | null {
    return this.#root.isEmpty() ? null : this.#root
  }

  /** Root digest. `EMPTY_DIGEST` for an empty tree. */
  rootDigest(): Hash {
    return this.#root.isEmpty() ? EMPTY_DIGEST : this.#root.hash()
  }

  /** True iff the given key is in the tree. */
  has(key: Hash): boolean {
    return this.#hexKeys.has(toHex(key))
  }
}

function leftmostKey(page: Page): Hash {
  let cur: Page = page
  while (cur.nodes.length > 0 && cur.nodes[0]!.ltPointer) {
    cur = cur.nodes[0]!.ltPointer!
  }
  if (cur.nodes.length === 0) {
    // Shouldn't happen — caller only calls this on non-empty trees.
    return new Uint8Array(HASH_LEN)
  }
  return cur.nodes[0]!.key
}

/** Walk a page subtree, yielding every key in ascending order. */
export { pageCollectKeys as collectKeys }
export type { MstNode, Page }
export { bytesEqual, compareHash, levelOf } from './level.js'
