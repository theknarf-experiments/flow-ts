// Bab-hash (https://bab-hash.org/spec) — a Merkle-tree-over-chunks
// hash with a streaming-verifiable encoding. Byte-exact port of the
// WILLIAM3 instantiation from the `bab_rs` reference implementation
// (https://codeberg.org/worm-blossom/bab_rs); see `william3.ts` for
// the compression function. This file owns the tree-shape walk and
// the streaming encode/decode wire format.
//
// Tree shape (spec §3, RFC 9162 style):
//   * Input is split into ≤ CHUNK_SIZE-byte chunks.
//   * For N chunks, the left subtree is a complete binary tree of size
//     2^k (largest power of two strictly less than N), the right
//     subtree recursively contains the remaining N − 2^k chunks.
//   * Leaves are the chunks themselves.
//
// The streaming wire format below is internal to @flow-ts/sync — it
// composes WILLIAM3 leaf and inner digests, but its framing of how
// sibling labels are interleaved with chunk bytes is not part of any
// canonical bab spec. (The spec describes streaming verification
// abstractly; the upstream Rust impl puts its concrete wire format
// in `src/william3/storage/`.)

import { CHUNK_SIZE, HASH_LEN, hashChunk, hashInner } from './william3.js'

export { CHUNK_SIZE, HASH_LEN }

export type Hash = Uint8Array // 32 bytes

/** Number of chunks for a byte-length L. By convention `chunkCount(0) === 1`
 *  (the empty input is one zero-length chunk). */
export function chunkCount(L: number): number {
  if (L === 0) return 1
  return Math.ceil(L / CHUNK_SIZE)
}

/** Split point for N chunks: the largest power of two strictly less
 *  than N. Caller must ensure N >= 2. */
function splitChunks(n: number): number {
  // Largest k = 2^i with k < n.
  let k = 1
  while (k * 2 < n) k *= 2
  return k
}

/** Compute the bab digest of `data`. */
export function babHash(data: Uint8Array): Hash {
  return labelOfRange(data, 0, data.length, true)
}

/** Label of the subtree covering data[start..end). */
function labelOfRange(data: Uint8Array, start: number, end: number, isRoot: boolean): Hash {
  const length = end - start
  const nChunks = chunkCount(length)
  if (nChunks <= 1) {
    return hashChunk(data.subarray(start, end), isRoot)
  }
  const splitCh = splitChunks(nChunks)
  const mid = start + splitCh * CHUNK_SIZE
  const left = labelOfRange(data, start, mid, false)
  const right = labelOfRange(data, mid, end, false)
  return hashInner(left, right, length, isRoot)
}

// -----------------------------------------------------------------------------
// Streaming encoding & verification.
//
// Wire format:
//   u64_be(L) || stream
//
// where `stream` visits the implicit tree in left-leaning DFS order.
// For each leaf, just before emitting its chunk bytes, the sender
// emits the labels of all siblings on the path from the *deepest
// node known to the receiver* down to this leaf's parent. After the
// chunk is verified the path's labels become known on the receiver
// side, so subsequent chunks need fewer (often zero) sibling labels.
//
// For chunk i in a tree of `n` total chunks, the number of new
// sibling labels emitted = (depth_of_leaf(i)) − (depth_of_LCA(i−1, i)),
// with depth_of_LCA(−1, 0) = 0 (i.e. the first chunk emits all its
// path siblings, from root downward).
// -----------------------------------------------------------------------------

/** A node in the implicit tree, identified by its byte range. */
interface TreeNode {
  start: number
  end: number
  isRoot: boolean
  /** Index in left-leaning DFS leaf order. Set for leaves only. */
  leafIndex?: number
}

/** Walk the tree leaves in DFS order, recording the path from the
 *  root to each leaf. Path entries are inner nodes from root (inclusive)
 *  down to the leaf's *parent* (inclusive); each entry says whether
 *  the leaf is reached via the left or right child of that inner node. */
interface PathStep {
  node: TreeNode
  goRight: boolean
  /** The sibling node (the child NOT on the leaf's path). */
  sibling: TreeNode
}

function buildLeafPaths(length: number): Array<{ leaf: TreeNode; path: PathStep[] }> {
  const out: Array<{ leaf: TreeNode; path: PathStep[] }> = []
  let leafCounter = 0

  function walk(node: TreeNode, path: PathStep[]): void {
    const n = chunkCount(node.end - node.start)
    if (n <= 1) {
      out.push({ leaf: { ...node, leafIndex: leafCounter++ }, path })
      return
    }
    const splitCh = splitChunks(n)
    const mid = node.start + splitCh * CHUNK_SIZE
    const left: TreeNode = { start: node.start, end: mid, isRoot: false }
    const right: TreeNode = { start: mid, end: node.end, isRoot: false }
    walk(left, [...path, { node, goRight: false, sibling: right }])
    walk(right, [...path, { node, goRight: true, sibling: left }])
  }

  walk({ start: 0, end: length, isRoot: true }, [])
  return out
}

/** Produce the streaming-verifiable encoding of `data`.
 *  Output layout: u64_be(L) || (sibling labels + chunk bytes)*. */
export function babEncode(data: Uint8Array): Uint8Array {
  const L = data.length
  const leaves = buildLeafPaths(L)
  // Compute labels for every node touched.
  const labels = new Map<string, Hash>()
  function labelKey(n: TreeNode): string {
    return `${n.start}:${n.end}`
  }
  function ensureLabel(n: TreeNode): Hash {
    const k = labelKey(n)
    const cached = labels.get(k)
    if (cached) return cached
    const lbl = labelOfRange(data, n.start, n.end, n.isRoot)
    labels.set(k, lbl)
    return lbl
  }

  const parts: Uint8Array[] = []
  // Length prefix.
  const lenBuf = new Uint8Array(8)
  new DataView(lenBuf.buffer).setBigUint64(0, BigInt(L), false) // big-endian
  parts.push(lenBuf)

  const seenAlongPath = new Set<string>()
  for (const { leaf, path } of leaves) {
    // For each path step, if we haven't yet emitted this inner node
    // (i.e. the receiver hasn't yet committed to its label), emit the
    // sibling label and mark the inner node as committed.
    for (const step of path) {
      const innerKey = labelKey(step.node)
      if (seenAlongPath.has(innerKey)) continue
      seenAlongPath.add(innerKey)
      parts.push(ensureLabel(step.sibling))
    }
    // Then the leaf bytes.
    parts.push(data.subarray(leaf.start, leaf.end))
  }

  // Concatenate.
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** Verify an encoded bab stream against an expected digest and return
 *  the decoded data. Throws on any mismatch. */
export function babDecode(expectedDigest: Hash, encoded: Uint8Array): Uint8Array {
  if (encoded.length < 8) throw new BabError('stream truncated: missing length prefix')
  const L = Number(new DataView(encoded.buffer, encoded.byteOffset, 8).getBigUint64(0, false))
  // Hard cap: the data alone can't be longer than what's left in the
  // stream. Without this, a tampered length prefix can make
  // `buildLeafPaths` try to materialise ~2^60 leaves.
  if (!Number.isSafeInteger(L) || L < 0 || L > encoded.length - 8) {
    throw new BabError('invalid length prefix')
  }

  const leaves = buildLeafPaths(L)
  const knownLabels = new Map<string, Hash>()
  function key(n: TreeNode): string {
    return `${n.start}:${n.end}`
  }
  // Root is the entire tree.
  const root: TreeNode = { start: 0, end: L, isRoot: true }
  knownLabels.set(key(root), expectedDigest)

  const out = new Uint8Array(L)
  let off = 8 // past the length prefix

  const seenAlongPath = new Set<string>()
  for (const { leaf, path } of leaves) {
    // Read freshly-emitted sibling labels for inner nodes newly on this path.
    for (const step of path) {
      const innerKey = key(step.node)
      if (seenAlongPath.has(innerKey)) continue
      seenAlongPath.add(innerKey)
      if (off + HASH_LEN > encoded.length) {
        throw new BabError('stream truncated: missing sibling label')
      }
      const sibLabel = encoded.subarray(off, off + HASH_LEN)
      off += HASH_LEN
      // Trust on faith for now — will be verified by the upward walk.
      knownLabels.set(key(step.sibling), new Uint8Array(sibLabel))
    }
    // Read the leaf's chunk bytes.
    const chunkLen = leaf.end - leaf.start
    if (off + chunkLen > encoded.length) {
      throw new BabError('stream truncated: missing chunk bytes')
    }
    const chunkBytes = encoded.subarray(off, off + chunkLen)
    off += chunkLen
    out.set(chunkBytes, leaf.start)

    // Walk up from the leaf: at each step, combine current with the
    // sibling and check the result against the known parent label.
    let curLabel = hashChunk(chunkBytes, path.length === 0 /* sole-chunk-is-root */)
    let curNode: TreeNode = leaf
    // Cache this leaf's label so later leaves can use it as a sibling
    // when walking up. Provisionally trusted; if the upward walk
    // doesn't verify the root, we throw and discard the map.
    knownLabels.set(key(leaf), curLabel)
    if (path.length === 0) {
      // Single-chunk tree: the leaf IS the root. Verify directly.
      if (!bytesEqual(curLabel, expectedDigest)) {
        throw new BabError('digest mismatch at root (single-chunk)')
      }
    }
    for (let i = path.length - 1; i >= 0; i--) {
      const step = path[i]!
      const sibLabel = knownLabels.get(key(step.sibling))
      if (!sibLabel) throw new BabError('internal: sibling label missing')
      const leftLabel = step.goRight ? sibLabel : curLabel
      const rightLabel = step.goRight ? curLabel : sibLabel
      const parentNode = step.node
      const parentLabel = hashInner(
        leftLabel,
        rightLabel,
        parentNode.end - parentNode.start,
        parentNode.isRoot,
      )
      // Verify against expected if known.
      const expected = knownLabels.get(key(parentNode))
      if (expected) {
        if (!bytesEqual(parentLabel, expected)) {
          throw new BabError('digest mismatch at inner node')
        }
        // Done walking up; the rest of the path is already verified.
        curLabel = parentLabel
        curNode = parentNode
        break
      }
      knownLabels.set(key(parentNode), parentLabel)
      curLabel = parentLabel
      curNode = parentNode
    }
    void curNode
  }

  if (off !== encoded.length) {
    throw new BabError(`trailing bytes in stream: ${encoded.length - off} extra`)
  }
  return out
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

export class BabError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BabError'
  }
}
