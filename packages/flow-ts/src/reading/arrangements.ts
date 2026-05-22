// Port of flowlog/src/reading/src/arrangements.rs
//
// The Rust crate defines `ArrangedDict` and `ArrangedSet` — pre-arranged
// trace wrappers used by DD's join operators. d2ts manages arrangements
// internally inside `join()` / `antiJoin()`; there's no equivalent surface
// to expose. This module is intentionally minimal — kept for API parity so
// downstream imports don't break.

export {} // empty: see comment above
