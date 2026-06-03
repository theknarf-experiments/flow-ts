// Page-range serialisation and the tree-aligned diff algorithm.
// Port of the canonical Rust `merkle-search-tree::diff` module.
//
// A `PageRange { start, end, hash }` describes one page's *entire
// subtree*: `start` is the min key reachable from this page (descend
// leftmost), `end` is the max (descend through high_page), and
// `hash` is the page's cached subtree digest.
//
// `serialisePageRanges(root)` walks the tree in pre-order DFS and
// emits one entry per page. The root emits first (with the
// tree-wide range), then each child, recursively.
//
// `diff(local, peer)` is asymmetric: it returns the key ranges
// `local` should fetch *from* `peer` to converge. For mutual sync,
// each side runs `diff(theirRanges, ourRanges)` independently.

import { type Hash } from '../bab/index.js'
import { compareHash } from './level.js'
import {
  collectKeys as pageCollectKeys,
  maxSubtreeKey,
  minSubtreeKey,
  type Page,
} from './page.js'

export interface PageRange {
  /** Min key of this page's subtree (inclusive). */
  start: Hash
  /** Max key of this page's subtree (inclusive). */
  end: Hash
  /** This page's cached subtree digest. */
  hash: Hash
}

export interface DiffRange {
  /** Inclusive lower bound of a key range local needs from peer. */
  start: Hash
  /** Inclusive upper bound. */
  end: Hash
}

/** Walk `page` in pre-order DFS, emitting one `PageRange` per page.
 *  Order: self, then for each node descend into its `ltPointer`,
 *  finally descend into `highPage`. */
export function serialisePageRanges(page: Page | null): PageRange[] {
  if (!page || page.nodes.length === 0) return []
  const out: PageRange[] = []
  walk(page, out)
  return out
}

function walk(page: Page, out: PageRange[]): void {
  out.push({
    start: minSubtreeKey(page),
    end: maxSubtreeKey(page),
    hash: page.hash(),
  })
  for (const n of page.nodes) {
    if (n.ltPointer) walk(n.ltPointer, out)
  }
  if (page.highPage) walk(page.highPage, out)
}

/** True iff `outer` covers all keys covered by `inner`. */
function isSupersetOf(outer: PageRange, inner: PageRange): boolean {
  return compareHash(outer.start, inner.start) <= 0 && compareHash(inner.end, outer.end) <= 0
}

/** True iff two ranges intersect. */
function overlaps(a: { start: Hash; end: Hash }, b: { start: Hash; end: Hash }): boolean {
  return compareHash(a.start, b.end) <= 0 && compareHash(b.start, a.end) <= 0
}

/** Merge any adjacent or overlapping ranges in-place. Assumes input
 *  is sorted by `start` ascending. */
function mergeOverlapping(ranges: DiffRange[]): void {
  if (ranges.length <= 1) return
  let write = 0
  for (let read = 1; read < ranges.length; read++) {
    const cur = ranges[write]!
    const next = ranges[read]!
    if (compareHash(next.start, cur.end) <= 0) {
      // Overlap or adjacent — merge.
      if (compareHash(next.end, cur.end) > 0) cur.end = next.end
    } else {
      ranges[++write] = next
    }
  }
  ranges.length = write + 1
}

/** Subtract `good` (a single consistent range) from every overlapping
 *  entry in `bad`, returning the result. */
function holePunch(bad: DiffRange[], good: DiffRange): DiffRange[] {
  const out: DiffRange[] = []
  for (const b of bad) {
    if (!overlaps(b, good)) {
      out.push(b)
      continue
    }
    if (compareHash(b.start, good.start) < 0) {
      // Slice before the good range. The "end" should be just before
      // good.start, but we don't have an inclusive predecessor; use
      // good.start itself and rely on the consumer to treat it as an
      // exclusive boundary. (For MST keys, this isn't lossy because
      // the good range owns those keys and the FETCH protocol
      // checks key membership.)
      out.push({ start: b.start, end: good.start })
    }
    if (compareHash(b.end, good.end) > 0) {
      out.push({ start: good.end, end: b.end })
    }
  }
  return out
}

function pageRangeFingerprint(r: PageRange): string {
  return `${rangeFingerprintBytes(r.start)}|${rangeFingerprintBytes(r.end)}|${rangeFingerprintBytes(r.hash)}`
}

function rangeFingerprintBytes(b: Hash): string {
  let s = ''
  for (let i = 0; i < b.length; i++) {
    const v = b[i]!
    s += (v >>> 4).toString(16) + (v & 0xf).toString(16)
  }
  return s
}

/** Compute the set of key ranges that `local` needs to fetch *from*
 *  `peer` in order to converge. Returns an empty array if local and
 *  peer agree on every page range.
 *
 *  Algorithm (tree-aligned, page-aware):
 *
 *    1. Two MSTs over the same key set produce byte-identical page
 *       boundaries and digests — that's history-independence.
 *    2. Walk peer's page ranges. A peer range is *consistent* iff
 *       local has a page range with identical (start, end, hash);
 *       otherwise it's *inconsistent* (peer's subtree there contains
 *       keys local needs to fetch, or differs structurally).
 *    3. Apply interval subtraction: consistent ranges are
 *       hole-punched out of the surrounding inconsistent ranges.
 *       This deferred reduction is what lets a large inconsistent
 *       parent range be narrowed to just the gaps around its
 *       already-consistent children.
 *
 *  For mutual sync, each side calls `diff(theirRanges, ourRanges)`
 *  independently — the one-way "what local should fetch from peer"
 *  semantics matches the canonical Rust crate. */
export function diff(local: PageRange[], peer: PageRange[]): DiffRange[] {
  if (peer.length === 0) return []
  const localFingerprints = new Set<string>()
  for (const r of local) localFingerprints.add(pageRangeFingerprint(r))

  const inconsistent: DiffRange[] = []
  const consistent: DiffRange[] = []
  for (const p of peer) {
    if (localFingerprints.has(pageRangeFingerprint(p))) {
      consistent.push({ start: p.start, end: p.end })
    } else {
      inconsistent.push({ start: p.start, end: p.end })
    }
  }
  if (inconsistent.length === 0) return []

  // Merge + sort each list before the subtraction pass.
  inconsistent.sort((a, b) => compareHash(a.start, b.start))
  mergeOverlapping(inconsistent)
  consistent.sort((a, b) => compareHash(a.start, b.start))
  mergeOverlapping(consistent)

  let bad = inconsistent
  for (const g of consistent) {
    bad = holePunch(bad, g)
  }
  bad.sort((a, b) => compareHash(a.start, b.start))
  mergeOverlapping(bad)
  return bad
}

/** Collect every key in `keys` (already sorted) whose value lies
 *  inside any of `ranges`. Used by the protocol layer to decide
 *  which keys to FETCH after a diff. */
export function keysInRanges(keys: Hash[], ranges: DiffRange[]): Hash[] {
  if (ranges.length === 0) return []
  const out: Hash[] = []
  for (const k of keys) {
    for (const r of ranges) {
      if (compareHash(k, r.start) >= 0 && compareHash(k, r.end) <= 0) {
        out.push(k)
        break
      }
    }
  }
  return out
}

// Re-export so tests can pull from one place.
export { pageCollectKeys as collectKeysFromPage }
