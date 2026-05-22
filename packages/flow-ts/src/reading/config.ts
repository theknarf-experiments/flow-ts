// Port of flowlog/src/reading/src/config.rs
//
// These constants are used by downstream consumers (planning's arity analysis,
// executing's codegen-style dispatch). They're kept here for API parity even
// though the TS port doesn't need per-arity codegen.

export const KV_MAX = 4
export const ROW_MAX = 7
export const PROD_MAX = 6
export const FALLBACK_ARITY = ROW_MAX

export const CodegenLimits = {
  KV_MAX,
  ROW_MAX,
  PROD_MAX,
  FALLBACK_ARITY,
} as const
