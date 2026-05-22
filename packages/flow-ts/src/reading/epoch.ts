// Port of flowlog/src/reading/src/epoch.rs
//
// d2ts already provides Version (single int or multidimensional) and an
// Antichain frontier type. The Rust `Epoch` wraps a u64; in TS we represent
// epochs as `number` directly, since that's what d2ts versions use.
//
// `Time` aliases `Epoch` (used for input session timestamps), and `Iter` is
// the inner iteration counter — d2ts's `iterate()` handles inner timestamps
// internally, so `Iter` is informational only.

export type Epoch = number
export type Time = Epoch
export type Iter = number

export const epochZero: Epoch = 0

/** Join (lattice max) of two epochs. */
export function epochJoin(a: Epoch, b: Epoch): Epoch {
  return Math.max(a, b)
}

/** Meet (lattice min) of two epochs. */
export function epochMeet(a: Epoch, b: Epoch): Epoch {
  return Math.min(a, b)
}
