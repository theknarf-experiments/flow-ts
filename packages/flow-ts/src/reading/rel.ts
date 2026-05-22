// Port of flowlog/src/reading/src/rel.rs
//
// In Rust, `Rel<G>` is a giant enum dispatching across Row<1>..Row<8> plus
// `FatRow` because Differential's `Collection` is generic over the data
// type — each arity needs a distinct variant. d2ts streams are uniformly
// `IStreamBuilder<T>` (T at runtime can be a tuple/array of any shape), so
// the TS port collapses both `Rel<G>` and `DoubleRel<G>` to single classes
// carrying their arity at the value level.

import type { IStreamBuilder } from '@flow-ts/db-ivm'
import { concat, distinct, map, negate } from '@flow-ts/db-ivm'
import { decodeRow, encodeRow } from './encoding.js'
import { isFatArity } from './row.js'
import type { Row } from './row.js'

/** Row collection ≃ Rust's `Rel<G>`. */
export class Rel<T extends Row = Row> {
  constructor(
    public readonly stream: IStreamBuilder<T>,
    public readonly arity: number,
  ) {}

  isFat(): boolean {
    return isFatArity(this.arity)
  }

  isThin(): boolean {
    return !this.isFat()
  }

  /** Concatenate two same-arity Rels. */
  concat(other: Rel<T>): Rel<T> {
    if (this.arity !== other.arity) {
      throw new Error(`concat: arity ${this.arity} vs ${other.arity}`)
    }
    return new Rel(this.stream.pipe(concat(other.stream)), this.arity)
  }

  /** A set-difference equivalent: keep rows in `this` not in `other`. */
  subtract(other: Rel<T>): Rel<T> {
    if (this.arity !== other.arity) {
      throw new Error(`subtract: arity ${this.arity} vs ${other.arity}`)
    }
    const merged = this.stream.pipe(concat(other.stream.pipe(negate())))
    return new Rel(dedupeRowStream(merged), this.arity)
  }

  /** Dedupe rows by content; equivalent to DD's `threshold_semigroup` form. */
  threshold(): Rel<T> {
    return new Rel(dedupeRowStream(this.stream), this.arity)
  }

  /**
   * Chop a row stream into a (key, value) keyed stream at index `at`.
   * Maps each Row to a `[Row, Row]` pair so it can feed d2ts's `join()`.
   */
  arrangeDouble(at: number): DoubleRel<T, T> {
    const arity = this.arity
    const keyed = this.stream.pipe(
      map((row: T) => {
        const key = row.slice(0, at) as unknown as T
        const value = row.slice(at) as unknown as T
        return [key, value] as [T, T]
      }),
    )
    return new DoubleRel<T, T>(keyed, at, arity - at)
  }
}

/**
 * Dedupe a row stream by content via the canonical row encoding (see
 * `encoding.ts`). Both K and V flow as strings to satisfy d2ts's reducer
 * and to avoid JS Map identity issues with array keys.
 */
function dedupeRowStream<T extends Row>(stream: IStreamBuilder<T>): IStreamBuilder<T> {
  return stream.pipe(
    map((row: T) => {
      const k = encodeRow(row)
      return [k, k] as [string, string]
    }),
    distinct(),
    map(([, v]) => decodeRow(v as string) as unknown as T),
  )
}

/** Keyed (k, v) row collection ≃ Rust's `DoubleRel<G>`. */
export class DoubleRel<K extends Row = Row, V extends Row = Row> {
  constructor(
    public readonly stream: IStreamBuilder<[K, V]>,
    public readonly keyArity: number,
    public readonly valueArity: number,
  ) {}

  arity(): [number, number] {
    return [this.keyArity, this.valueArity]
  }

  isFat(): boolean {
    return isFatArity(this.keyArity) || isFatArity(this.valueArity)
  }

  isThin(): boolean {
    return !this.isFat()
  }

  /** Concatenate two same-arity DoubleRels. */
  concat(other: DoubleRel<K, V>): DoubleRel<K, V> {
    if (this.keyArity !== other.keyArity || this.valueArity !== other.valueArity) {
      throw new Error(
        `concat: (${this.keyArity}, ${this.valueArity}) vs (${other.keyArity}, ${other.valueArity})`,
      )
    }
    return new DoubleRel<K, V>(
      this.stream.pipe(concat(other.stream)),
      this.keyArity,
      this.valueArity,
    )
  }
}
