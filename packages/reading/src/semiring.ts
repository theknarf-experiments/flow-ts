// Port of flowlog/src/reading/src/semiring.rs
//
// db-ivm uses signed integer multiplicities (`number`) — equivalent to
// FlowLog's `isize-type` feature. The `present-type` (boolean-presence)
// optimization isn't natively available. We expose only the `isize` flavor.
//
// `Min` is a standalone monoidal value type used via reduce/groupBy
// aggregations rather than as a diff lattice.

/** Signed integer multiplicity — matches db-ivm's diff representation. */
export type Semiring = number

export function semiringOne(): Semiring {
  return 1
}

export const SEMIRING_TYPE = 'isize' as const

/** MIN semiring. Used for SSSP-style aggregation. */
export class Min {
  /** Sentinel for "no value" / additive identity. */
  static readonly INFINITY = Number.POSITIVE_INFINITY

  constructor(public value: number) {}

  static new(value: number): Min {
    return new Min(value)
  }

  static infinity(): Min {
    return new Min(Min.INFINITY)
  }

  static zero(): Min {
    return Min.infinity()
  }

  static from(value: number): Min {
    return new Min(value)
  }

  isInfinity(): boolean {
    return this.value === Min.INFINITY
  }

  isZero(): boolean {
    return false
  }

  /** In-place ⊕ (semigroup add): take the minimum. */
  plusEquals(rhs: Min): void {
    if (rhs.value < this.value) this.value = rhs.value
  }

  /** Multiplication by a scalar leaves the Min value unchanged. */
  multiply(_rhs: number): Min {
    return new Min(this.value)
  }

  equals(other: Min): boolean {
    return this.value === other.value
  }
}
