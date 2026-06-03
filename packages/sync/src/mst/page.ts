// Page and Node, the MST building blocks. Faithful port of the
// canonical `merkle-search-tree` Rust crate's `page.rs` / `node.rs`.
//
// Tree invariants:
//   * A Page has a `level: number` and a sorted `nodes: Node[]`
//     (ascending by key). All keys in the page have `levelOf(key) ===
//     page.level`.
//   * Each Node owns `ltPointer: Page | null` — a strictly-less-than
//     child subtree.
//   * A Page also has `highPage: Page | null` — the
//     strictly-greater-than-all-nodes child subtree.
//   * Every child sub-page has `level < parent.level`.
//
// Upsert dispatches on level:
//   * `level < self.level`  → descend into the appropriate
//     `ltPointer` (or `highPage`) and recurse.
//   * `level === self.level` → insert at this page, splitting the
//     affected child subtree via `splitOffLt`.
//   * `level > self.level`  → return `InsertIntermediate` so the
//     caller can grow a new parent page at the new key's level.
//
// We drop the canonical's `value_hash` field — our keys are
// content hashes already (`factKey(relation, encodedRow)`), so the
// key IS the value commitment. This means no "same key, different
// value" updates are possible, which is exactly the constraint that
// makes the simplification safe.

import { babHash, HASH_LEN, type Hash } from '../bab/index.js'
import { bytesEqual, compareHash } from './level.js'

export interface MstNode {
  key: Hash
  ltPointer: Page | null
}

export class Page {
  /** All nodes in this page have `levelOf(key) === level`. */
  level: number
  /** Ascending by key. */
  nodes: MstNode[]
  /** Strictly-greater-than-last-node subtree. */
  highPage: Page | null
  /** Cached subtree digest. `null` = dirty; must rebuild. */
  #cachedHash: Hash | null = null

  constructor(level: number, nodes: MstNode[], highPage: Page | null = null) {
    this.level = level
    this.nodes = nodes
    this.highPage = highPage
  }

  /** Page subtree digest, generating + caching as needed. */
  hash(): Hash {
    if (this.#cachedHash !== null) return this.#cachedHash
    // Concatenate per node: [ltPointer.hash if any] ‖ key
    // Then append highPage.hash if any.
    // No domain byte, no length prefix — same layout as the canonical
    // (minus value_hash). Order is breaking; do not change.
    const parts: Uint8Array[] = []
    for (const n of this.nodes) {
      if (n.ltPointer) parts.push(n.ltPointer.hash())
      parts.push(n.key)
    }
    if (this.highPage) parts.push(this.highPage.hash())
    let total = 0
    for (const p of parts) total += p.length
    const buf = new Uint8Array(total)
    let off = 0
    for (const p of parts) {
      buf.set(p, off)
      off += p.length
    }
    this.#cachedHash = babHash(buf)
    return this.#cachedHash
  }

  /** Mark this page's cached hash as dirty. */
  invalidateHash(): void {
    this.#cachedHash = null
  }

  /** True iff this page has no nodes (empty root). */
  isEmpty(): boolean {
    return this.nodes.length === 0
  }
}

export type UpsertResult =
  | { kind: 'complete' }
  | { kind: 'insertIntermediate'; key: Hash }

/** Index of the first node whose `key >= key`. Returns `nodes.length`
 *  if all node keys are strictly less than `key`. */
export function findIdx(nodes: MstNode[], key: Hash): number {
  // Sorted; could be binary, but linear is fine at MST page sizes
  // (typically O(level_base) entries per page).
  for (let i = 0; i < nodes.length; i++) {
    if (compareHash(key, nodes[i]!.key) <= 0) return i
  }
  return nodes.length
}

/** Upsert `key` into `page`. Returns `complete` if done, or
 *  `insertIntermediate` if the caller needs to grow a parent. */
export function upsert(page: Page, key: Hash, level: number): UpsertResult {
  if (level < page.level) {
    // Descend.
    const idx = findIdx(page.nodes, key)
    let child: Page | null
    if (idx < page.nodes.length) {
      child = page.nodes[idx]!.ltPointer
    } else {
      child = page.highPage
    }
    if (!child) {
      child = new Page(level, [])
      if (idx < page.nodes.length) page.nodes[idx]!.ltPointer = child
      else page.highPage = child
    }
    const r = upsert(child, key, level)
    if (r.kind === 'insertIntermediate') {
      // The child returned a level higher than itself; insert an
      // intermediate page between us and the child at the new key's
      // level.
      insertIntermediatePage(page, idx, r.key, level)
    }
    page.invalidateHash()
    return { kind: 'complete' }
  }
  if (level === page.level) {
    upsertNode(page, key)
    page.invalidateHash()
    return { kind: 'complete' }
  }
  // level > page.level
  return { kind: 'insertIntermediate', key }
}

/** Insert `key` into the page at this level. If the key matches an
 *  existing node, it's a no-op (deduplication is the only update
 *  semantic — we don't carry a value to mutate). Otherwise the
 *  affected child subtree is split around the new key. */
function upsertNode(page: Page, key: Hash): void {
  const idx = findIdx(page.nodes, key)
  // Exact match — already present.
  if (idx < page.nodes.length && bytesEqual(page.nodes[idx]!.key, key)) return

  // The child subtree that currently covers the key's slot:
  //   * If idx < nodes.length, that's `nodes[idx].ltPointer`.
  //   * Otherwise the page's `highPage`.
  // Split it at `key`: lt half becomes the new node's ltPointer,
  // gte half stays as the existing slot's pointer.
  const slot: { get: () => Page | null; set: (p: Page | null) => void } =
    idx < page.nodes.length
      ? {
          get: () => page.nodes[idx]!.ltPointer,
          set: (p) => {
            page.nodes[idx]!.ltPointer = p
          },
        }
      : {
          get: () => page.highPage,
          set: (p) => {
            page.highPage = p
          },
        }

  const newLtPage = splitOffLt(slot.get(), key)
  if (newLtPage) {
    // Canonical fixup: if the lt page's own highPage contains
    // anything >= key, that needs to move out and be re-inserted as
    // *this* page's highPage adjacent to the new node.
    const highLt = splitOffLt(newLtPage.highPage, key)
    const oldHigh = newLtPage.highPage
    newLtPage.highPage = highLt
    if (oldHigh && oldHigh !== highLt) {
      insertHighPage(page, oldHigh)
    }
    newLtPage.invalidateHash()
  }
  // After the split, the slot's page may have been mutated to empty
  // (no nodes left, no highPage). Distinct from `null`, an empty
  // Page contributes to its parent's digest computation (via
  // page.hash() over an empty children list). That breaks
  // history-independence: re-inserting the same keys in a different
  // order can leave a `null` slot where forward insertion would
  // leave an empty Page. Nullify here so both orderings reach the
  // canonical "no child here" state.
  const existing = slot.get()
  if (existing && existing.isEmpty() && existing.highPage === null) {
    slot.set(null)
  }
  const newNode: MstNode = { key, ltPointer: newLtPage }
  page.nodes.splice(idx, 0, newNode)
}

/** Split a child subtree at `key`. Mutates `page` in place to keep
 *  only nodes with `key' >= key`; returns a new Page holding the
 *  strictly-less-than nodes (or `null` if there are none).
 *
 *  Recurses into the first node's `ltPointer` (which may also need
 *  splitting) and the `highPage`. */
export function splitOffLt(page: Page | null, key: Hash): Page | null {
  if (!page) return null
  // Find first node with key >= split-key.
  const idx = findIdx(page.nodes, key)
  const ltNodes = page.nodes.slice(0, idx)
  const gteNodes = page.nodes.slice(idx)

  let ltPage: Page | null = null
  if (ltNodes.length > 0) {
    ltPage = new Page(page.level, ltNodes, null)
  }
  // If the boundary node's ltPointer contains keys that should also
  // be in the lt half, split it too.
  if (gteNodes.length > 0) {
    const boundary = gteNodes[0]!
    const childSplit = splitOffLt(boundary.ltPointer, key)
    if (childSplit) {
      if (ltPage) ltPage.highPage = childSplit
      else ltPage = childSplit
      boundary.ltPointer = null
    }
  } else {
    // No gte nodes left — the highPage might still contain
    // strictly-less keys (shouldn't, by construction, but split
    // anyway for safety).
    const highSplit = splitOffLt(page.highPage, key)
    if (highSplit) {
      if (ltPage) ltPage.highPage = highSplit
      else ltPage = highSplit
      page.highPage = null
    }
  }
  page.nodes = gteNodes
  page.invalidateHash()
  return ltPage
}

/** Insert a Page as the highPage of `parent`. If `parent.highPage`
 *  already exists, the new one's nodes/highPage are merged into it
 *  (or vice versa, picking the page at the right level). */
function insertHighPage(parent: Page, page: Page): void {
  if (!parent.highPage) {
    parent.highPage = page
    return
  }
  // Both exist — concatenate their nodes (the new `page` covers a
  // range strictly greater than `parent`'s last node; merge with
  // `parent.highPage`'s nodes, all of which are at the same level).
  if (parent.highPage.level === page.level) {
    // Same level → merge node lists (page.nodes come after).
    parent.highPage.nodes.push(...page.nodes)
    if (page.highPage) {
      insertHighPage(parent.highPage, page.highPage)
    }
    parent.highPage.invalidateHash()
  } else if (parent.highPage.level < page.level) {
    // The new page is at a higher level — it should become the new
    // highPage, with the existing highPage tucked under it.
    insertHighPage(page, parent.highPage)
    parent.highPage = page
  } else {
    // The existing highPage is at a higher level — descend.
    insertHighPage(parent.highPage, page)
    parent.highPage.invalidateHash()
  }
}

/** Replace `child` (located at slot `idx` of `parent`) with a new
 *  intermediate page at `level` containing `key`. The original
 *  child is split: lt becomes the new key's ltPointer, gte sits in
 *  the new intermediate page's highPage. */
function insertIntermediatePage(
  parent: Page,
  idx: number,
  key: Hash,
  level: number,
): void {
  const existing = idx < parent.nodes.length ? parent.nodes[idx]!.ltPointer : parent.highPage
  const newLt = splitOffLt(existing, key)
  // Same empty-page hygiene as upsertNode: if splitOffLt drained
  // all entries from `existing`, treat it as null in the
  // intermediate's highPage slot.
  const gtePage = existing && (existing.isEmpty() && existing.highPage === null) ? null : existing
  const newNode: MstNode = { key, ltPointer: newLt }
  const intermediate = new Page(level, [newNode], gtePage)
  if (idx < parent.nodes.length) parent.nodes[idx]!.ltPointer = intermediate
  else parent.highPage = intermediate
}

/** Walk a page subtree, yielding every key in ascending order. */
export function* collectKeys(page: Page | null): IterableIterator<Hash> {
  if (!page) return
  for (const n of page.nodes) {
    yield* collectKeys(n.ltPointer)
    yield n.key
  }
  yield* collectKeys(page.highPage)
}

/** Minimum key reachable from this page (descending through the
 *  leftmost ltPointers). */
export function minSubtreeKey(page: Page): Hash {
  let cur: Page = page
  while (cur.nodes.length > 0 && cur.nodes[0]!.ltPointer) {
    cur = cur.nodes[0]!.ltPointer!
  }
  if (cur.nodes.length === 0) {
    // Page with no nodes — should only happen for the empty root.
    return cur.highPage ? minSubtreeKey(cur.highPage) : new Uint8Array(HASH_LEN)
  }
  return cur.nodes[0]!.key
}

/** Maximum key reachable from this page (descending through highPage
 *  pointers). */
export function maxSubtreeKey(page: Page): Hash {
  let cur: Page = page
  while (cur.highPage) cur = cur.highPage
  if (cur.nodes.length === 0) {
    const allOnes = new Uint8Array(HASH_LEN)
    allOnes.fill(0xff)
    return allOnes
  }
  return cur.nodes[cur.nodes.length - 1]!.key
}
