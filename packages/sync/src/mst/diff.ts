// Re-export the tree-aligned page-range diff from page-range.ts.
// The old `collectKeys → merge-walk` symmetric-difference algorithm
// was an O(|A| + |B|) reference impl that didn't exploit the MST
// structure. The new diff walks the tree's own page ranges in
// lockstep, the way the canonical crate intends.

export {
  diff,
  serialisePageRanges,
  keysInRanges,
  type DiffRange,
  type PageRange,
} from './page-range.js'
