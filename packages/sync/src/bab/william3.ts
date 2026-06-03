// WILLIAM3 — the canonical bab-hash instantiation
// (https://bab-hash.org/spec). Byte-exact port of `bab_rs`
// (https://codeberg.org/worm-blossom/bab_rs), so digests match the
// upstream Rust reference implementation.
//
// The algorithm is a BLAKE3-shaped compression function with a few
// targeted deviations:
//   * Custom IV constants (BLAKE3 digest of the ASCII string "WILLIAM3"),
//     used both as the seeded chaining value and as state[8..12].
//   * Per-chunk counter `t` is always 0 (chunks are not numbered).
//   * For inner nodes, `t` carries the subtree byte length — a u64 used
//     by the spec to enable constant-size length proofs.
//   * `block_len` field in the compression state is hard-coded to 64
//     even on the (zero-padded) final short block — that's a deliberate
//     WILLIAM3 divergence from standard BLAKE3.
//   * Inner-node message buffer is just `left_label ‖ right_label`
//     (exactly 64 bytes); there is no tag byte and length is not
//     serialised into the message.
//   * Empty input short-circuits compression entirely and returns the
//     LE-encoded IV bytes directly.
//
// We use BLAKE3's flag bits (CHUNK_START/CHUNK_END/PARENT/ROOT/KEYED_HASH)
// for domain separation rather than appended bytes, matching the spec.

const BLOCK_LEN = 64
export const HASH_LEN = 32
export const CHUNK_SIZE = 1024

// BLAKE3 flag bits (used by WILLIAM3 for domain separation, per spec).
const CHUNK_START = 1 << 0 // 0x01
const CHUNK_END = 1 << 1 // 0x02
const PARENT = 1 << 2 // 0x04
const ROOT = 1 << 3 // 0x08

// WILLIAM3 IV (BLAKE3 digest of the ASCII string "WILLIAM3").
// `bab_rs/src/william3/basics.rs`, comment: "These are different
// for WILLIAM3 than for BLAKE3!"
const IV: ReadonlyArray<number> = [
  0xc88f633b, 0x4168fbf2, 0x6ba32583, 0xb0ff1847, 0xac57e47d, 0xa8931330, 0x796a4645, 0x6b28a3ee,
]

// BLAKE3 message schedule — 7 rounds, each a permutation of 0..15.
const MSG_SCHEDULE: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8],
  [3, 4, 10, 12, 13, 2, 7, 14, 6, 5, 9, 0, 11, 15, 8, 1],
  [10, 7, 12, 9, 14, 3, 13, 15, 4, 0, 11, 2, 5, 8, 1, 6],
  [12, 13, 9, 11, 15, 10, 14, 8, 7, 2, 5, 3, 0, 1, 6, 4],
  [9, 14, 11, 5, 8, 12, 15, 1, 13, 3, 0, 10, 2, 6, 4, 7],
  [11, 15, 5, 0, 1, 9, 8, 6, 14, 10, 2, 12, 3, 4, 7, 13],
]

function rotr32(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0
}

function g(
  s: Uint32Array,
  a: number,
  b: number,
  c: number,
  d: number,
  x: number,
  y: number,
): void {
  s[a] = (s[a]! + s[b]! + x) >>> 0
  s[d] = rotr32(s[d]! ^ s[a]!, 16)
  s[c] = (s[c]! + s[d]!) >>> 0
  s[b] = rotr32(s[b]! ^ s[c]!, 12)
  s[a] = (s[a]! + s[b]! + y) >>> 0
  s[d] = rotr32(s[d]! ^ s[a]!, 8)
  s[c] = (s[c]! + s[d]!) >>> 0
  s[b] = rotr32(s[b]! ^ s[c]!, 7)
}

function round(state: Uint32Array, msg: Uint32Array, roundIdx: number): void {
  const sch = MSG_SCHEDULE[roundIdx]!
  g(state, 0, 4, 8, 12, msg[sch[0]!]!, msg[sch[1]!]!)
  g(state, 1, 5, 9, 13, msg[sch[2]!]!, msg[sch[3]!]!)
  g(state, 2, 6, 10, 14, msg[sch[4]!]!, msg[sch[5]!]!)
  g(state, 3, 7, 11, 15, msg[sch[6]!]!, msg[sch[7]!]!)
  g(state, 0, 5, 10, 15, msg[sch[8]!]!, msg[sch[9]!]!)
  g(state, 1, 6, 11, 12, msg[sch[10]!]!, msg[sch[11]!]!)
  g(state, 2, 7, 8, 13, msg[sch[12]!]!, msg[sch[13]!]!)
  g(state, 3, 4, 9, 14, msg[sch[14]!]!, msg[sch[15]!]!)
}

/** Load 64 bytes as 16 little-endian u32s into `msg`. */
function loadMsg(block: Uint8Array, msg: Uint32Array): void {
  for (let i = 0; i < 16; i++) {
    const o = i * 4
    msg[i] =
      (block[o]! | (block[o + 1]! << 8) | (block[o + 2]! << 16) | (block[o + 3]! << 24)) >>> 0
  }
}

/** Compress one 64-byte block into the chaining value (in place). */
function compressInPlace(
  cv: Uint32Array,
  block: Uint8Array,
  counter: number,
  flags: number,
): void {
  const msg = new Uint32Array(16)
  loadMsg(block, msg)
  const state = new Uint32Array(16)
  for (let i = 0; i < 8; i++) state[i] = cv[i]!
  state[8] = IV[0]!
  state[9] = IV[1]!
  state[10] = IV[2]!
  state[11] = IV[3]!
  state[12] = counter >>> 0
  // High 32 bits of the counter. For typical EDB-row payloads
  // `counter` stays well below 2^32, but we still emit the upper word
  // for correctness on large inputs.
  state[13] = Math.floor(counter / 0x100000000) >>> 0
  // Per WILLIAM3 spec: block_len is the fixed BLOCK_LEN, NOT the
  // actual data length in this (possibly short, zero-padded) block.
  state[14] = BLOCK_LEN
  state[15] = flags >>> 0
  for (let r = 0; r < 7; r++) round(state, msg, r)
  // Full BLAKE3 feed-forward: 16-word XOR.
  for (let i = 0; i < 8; i++) cv[i] = (state[i]! ^ state[i + 8]!) >>> 0
}

function cvToBytesLE(cv: Uint32Array): Uint8Array {
  const out = new Uint8Array(32)
  for (let i = 0; i < 8; i++) {
    const w = cv[i]!
    const o = i * 4
    out[o] = w & 0xff
    out[o + 1] = (w >>> 8) & 0xff
    out[o + 2] = (w >>> 16) & 0xff
    out[o + 3] = (w >>> 24) & 0xff
  }
  return out
}

/** Equivalent of `bab_rs::william3::portable::hash1`. Chains `input`
 *  through 0+ compress calls. Empty input returns the LE-encoded IV
 *  (key) bytes directly with no compression. */
function hash1(
  input: Uint8Array,
  key: ReadonlyArray<number>,
  counter: number,
  flags: number,
  flagsStart: number,
  flagsEnd: number,
): Uint8Array {
  const cv = new Uint32Array(8)
  for (let i = 0; i < 8; i++) cv[i] = key[i]!
  if (input.length === 0) return cvToBytesLE(cv)
  let blockFlags = flags | flagsStart
  let pos = 0
  while (pos < input.length) {
    const remaining = input.length - pos
    if (remaining <= BLOCK_LEN) blockFlags |= flagsEnd
    const block = new Uint8Array(BLOCK_LEN)
    const take = Math.min(remaining, BLOCK_LEN)
    block.set(input.subarray(pos, pos + take))
    compressInPlace(cv, block, counter, blockFlags)
    blockFlags = flags // subsequent blocks: no start flag
    pos += take
  }
  return cvToBytesLE(cv)
}

/** Hash a single chunk (≤ CHUNK_SIZE bytes) as a leaf. */
export function hashChunk(chunk: Uint8Array, isRoot: boolean): Uint8Array {
  let flagsEnd = CHUNK_END
  if (isRoot) flagsEnd |= ROOT
  return hash1(chunk, IV, 0, 0, CHUNK_START, flagsEnd)
}

/** Hash an inner node from two child labels and the byte-length of
 *  the subtree rooted here. Length is fed into the `t` counter; the
 *  message buffer is just `left ‖ right` (64 bytes, no length, no tag). */
export function hashInner(
  left: Uint8Array,
  right: Uint8Array,
  length: number,
  isRoot: boolean,
): Uint8Array {
  let flags = PARENT
  if (isRoot) flags |= ROOT
  const message = new Uint8Array(BLOCK_LEN)
  message.set(left, 0)
  message.set(right, 32)
  return hash1(message, IV, length, flags, 0, 0)
}
