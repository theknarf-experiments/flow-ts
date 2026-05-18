// Canonical Row ↔ string encoding for use with d2ts operators.
//
// Two d2ts behaviors force this encoding layer:
//
//   (1) The internal Index uses raw JS Map equality on keys. Array refs (the
//       natural shape of a Row) are unique-per-instance, so equal-content
//       rows wouldn't collapse if used as Map keys directly.
//
//   (2) The `reduce` / `distinct` operators JSON.stringify values internally
//       to track deltas, which throws on bigint-bearing rows.
//
// `encodeRow` produces a primitive string suitable for both. `decodeRow`
// reverses it. The format is a comma-delimited list of bigint .toString()
// values (bigints never contain commas, so this is unambiguous).

import type { Row } from './row.js'

/** Encode a Row to a canonical comma-delimited string. */
export function encodeRow(row: Row): string {
  let s = ''
  for (const v of row) {
    s += v.toString()
    s += ','
  }
  return s
}

/** Inverse of `encodeRow`. Empty string → empty row. */
export function decodeRow(k: string): bigint[] {
  if (k === '') return []
  // Each encoded row ends in a trailing ',' — strip it before splitting.
  return k.slice(0, -1).split(',').map((s) => BigInt(s))
}
