// Port of flowlog/src/reading/src/row.rs
//
// The Rust crate has two row types — Row<N> (stack-allocated, const-generic)
// and FatRow (heap-allocated SmallVec). JS has neither stack allocation nor
// const generics, so the TS port collapses both to a single `Row` type backed
// by a `number[]`. Rust's values are i64; we use JS `number` (a float64) which
// covers the safe-integer range up to 2^53. Datalog values in practice are
// small IDs / counts so this is plenty. Switching from bigint to number is a
// big perf win: hardware arithmetic instead of GMP-style routines, faster
// hashing, no allocation per arith op.

import { FALLBACK_ARITY } from './config.js'

/** A row is an ordered tuple of integer-shaped values stored as `number`. */
export type Row = readonly number[]

/** Alias kept for direct correspondence with the Rust naming. */
export type FatRow = Row

export function makeRow(): number[] {
  return []
}

export function makeFatRow(): number[] {
  return []
}

export function rowArity(r: Row): number {
  return r.length
}

export function rowColumn(r: Row, id: number): number {
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
