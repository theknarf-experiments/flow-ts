// Port of flowlog/src/reading/src/row.rs
//
// The Rust crate has two row types — Row<N> (stack-allocated, const-generic)
// and FatRow (heap-allocated SmallVec). JS has neither stack allocation nor
// const generics, so the TS port collapses both to a single `Row` type backed
// by a bigint[]. The thin/fat distinction is preserved as a runtime flag for
// API parity with downstream consumers that still look at it.

import { FALLBACK_ARITY } from './config.js'

/** A row is an ordered tuple of i64-shaped values, kept as bigints. */
export type Row = readonly bigint[]

/** Alias kept for direct correspondence with the Rust naming. */
export type FatRow = Row

export function makeRow(): bigint[] {
  return []
}

export function makeFatRow(): bigint[] {
  return []
}

export function rowArity(r: Row): number {
  return r.length
}

export function rowColumn(r: Row, id: number): bigint {
  const v = r[id]
  if (v === undefined) {
    throw new Error(`rowColumn: index ${id} out of range (arity ${r.length})`)
  }
  return v
}

export function rowToString(r: Row): string {
  return r.map((v) => v.toString()).join(', ')
}

/** Mirrors the Rust thin/fat distinction; meaningful only as a layout hint. */
export function isFatArity(arity: number): boolean {
  return arity > FALLBACK_ARITY
}
