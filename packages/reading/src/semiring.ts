// Port of flowlog/src/reading/src/semiring.rs
//
// d2ts uses signed integer multiplicities (`number`) — equivalent to FlowLog's
// `isize-type` feature. The `present-type` (boolean-presence) optimization
// isn't natively available in d2ts. We expose only the `isize` flavor.
//
// `Min` is ported as a standalone monoidal value type. The Rust version uses
// it as a custom DD diff; d2ts doesn't yet support custom diff types, so on
// the TS side `Min` is a utility used via reduce/groupBy aggregations rather
// than as a diff lattice.

/** Signed integer multiplicity — matches d2ts's diff representation. */
export type Semiring = number

export function semiringOne(): Semiring {
  return 1
}

export const SEMIRING_TYPE = 'isize' as const

/** MIN semiring. Used for SSSP-style aggregation. */
export class Min {
  /** Sentinel for "no value" / additive identity. Uses 2^64 - 1 (u64::MAX). */
  static readonly INFINITY = (1n << 64n) - 1n

  constructor(public value: bigint) {}

  static new(value: bigint): Min {
    return new Min(value)
  }

  static infinity(): Min {
    return new Min(Min.INFINITY)
  }

  static zero(): Min {
    // Additive identity in the MIN semiring is infinity (min(a, ∞) = a).
    return Min.infinity()
  }

  static from(value: bigint): Min {
    return new Min(value)
  }

  isInfinity(): boolean {
    return this.value === Min.INFINITY
  }

  /** In a MIN semiring is_zero is always false (values are never "absent"). */
  isZero(): boolean {
    return false
  }

  /** In-place ⊕ (semigroup add): take the minimum. */
  plusEquals(rhs: Min): void {
    if (rhs.value < this.value) this.value = rhs.value
  }

  /** Multiplication by an i64 leaves the Min value unchanged. */
  multiply(_rhs: bigint): Min {
    return new Min(this.value)
  }

  equals(other: Min): boolean {
    return this.value === other.value
  }
}
