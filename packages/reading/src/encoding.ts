// Canonical Row ↔ string encoding for use as Map keys in joins/reduces.
//
// db-ivm's `Index` uses raw JS Map equality for the top-level join key, so
// content-distinct rows used as keys must collapse to a primitive. Numbers
// can't carry full row-tuple identity, so we encode tuples as comma-joined
// strings. Values flowing as plain `number[]` (rather than keys) don't need
// to round-trip through this layer.

import type { Row } from './row.js'

/** Encode a Row to a canonical comma-delimited string. */
export function encodeRow(row: Row): string {
  let s = ''
  for (let i = 0; i < row.length; i++) {
    s += row[i]!
    s += ','
  }
  return s
}

/** Inverse of `encodeRow`. Empty string → empty row. */
export function decodeRow(k: string): number[] {
  if (k === '') return []
  // Each encoded row ends in a trailing ',' — strip it before splitting.
  const parts = k.slice(0, -1).split(',')
  const out = new Array<number>(parts.length)
  for (let i = 0; i < parts.length; i++) out[i] = Number(parts[i])
  return out
}
