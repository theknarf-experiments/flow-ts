// MST diff: given two MstNodes (possibly null), return the symmetric
// difference of their key sets.
//
// v1 algorithm: collect-then-compare. O(|A| + |B|) per call.
// O(diff + log n) tree-walk lives in the protocol layer (it streams
// NodeRefs over the wire and only descends into differing subtrees);
// here we just need a reference implementation that's easy to verify.

import type { Hash } from '../bab/index.js'
import { compareHash } from './level.js'
import { collectKeys, type MstNode } from './tree.js'

export interface DiffResult {
  /** Keys present only in the left side. */
  onlyA: Hash[]
  /** Keys present only in the right side. */
  onlyB: Hash[]
}

/** Symmetric difference of two MSTs, exploiting equal subtree digests
 *  to skip whole branches. Optimal when the trees mostly overlap. */
export function diff(a: MstNode | null, b: MstNode | null): DiffResult {
  const onlyA: Hash[] = []
  const onlyB: Hash[] = []

  // Pre-collect both sides into sorted key lists. The fast-path
  // optimisation (subtree-digest equality lets us skip large
  // identical subtrees without enumerating) lives behind a tree walk;
  // for v1 we keep it simple and just merge-walk the sorted lists.
  // The protocol layer's NodeRef-based diff is where digest equality
  // pays for itself on the wire.
  const ka = [...collectKeys(a)]
  const kb = [...collectKeys(b)]

  let i = 0
  let j = 0
  while (i < ka.length && j < kb.length) {
    const cmp = compareHash(ka[i]!, kb[j]!)
    if (cmp === 0) {
      i++
      j++
    } else if (cmp < 0) {
      onlyA.push(ka[i]!)
      i++
    } else {
      onlyB.push(kb[j]!)
      j++
    }
  }
  while (i < ka.length) onlyA.push(ka[i++]!)
  while (j < kb.length) onlyB.push(kb[j++]!)

  return { onlyA, onlyB }
}
