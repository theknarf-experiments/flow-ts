// Port of flowlog/src/reading/src/row.rs
//
// The Rust crate has two row types — Row<N> (stack-allocated, const-generic)
// and FatRow (heap-allocated SmallVec). JS has neither stack allocation nor
// const generics, so the TS port collapses both to a single `Row` type.
// Cell values are JS primitives typed as `Value = number | string` (see
// `value.ts`); strings live inline rather than being interned, because
// db-ivm's hashing and `Map` keying already treat strings as first-class.
// Number cells use float64 (safe-integer range 2^53), which is plenty for
// the IDs/counts Datalog programs deal with — and switching from bigint to
// number was a meaningful perf win (hardware arithmetic, faster hashing,
// no per-op allocation).

import { FALLBACK_ARITY } from './config.js'
import type { Value } from './value.js'

/** A row is an ordered tuple of cell values. Cell type is `Value`; mixed
 *  numeric / string columns are supported per the program's `.decl`. */
export type Row = readonly Value[]

/** Alias kept for direct correspondence with the Rust naming. */
export type FatRow = Row

export function makeRow(): Value[] {
  return []
}

export function makeFatRow(): Value[] {
  return []
}

export function rowArity(r: Row): number {
  return r.length
}

export function rowColumn(r: Row, id: number): Value {
  const v = r[id]
  if (v === undefined) {
    throw new Error(`rowColumn: index ${id} out of range (arity ${r.length})`)
  }
  return v
}

export function rowToString(r: Row): string {
  // JS `String(v)` already does the right thing for both numbers and
  // strings; no codec round-trip needed for display.
  return r.map((v) => String(v)).join(', ')
}

/** Mirrors the Rust thin/fat distinction; meaningful only as a layout hint. */
export function isFatArity(arity: number): boolean {
  return arity > FALLBACK_ARITY
}
