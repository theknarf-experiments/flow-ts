// The incremental-dataflow layer the engine runs on: a vendored fork of
// TanStack DB's ivm package, MIT, with the licence and the list of divergences
// in ./LICENSE.
//
// It lives inside this package rather than beside it because it is not a
// separable product. It is a fork with engine-shaped changes — the time/version
// machinery removed, `iterate` driven by a queue instead of a clock — so there is
// no upstream to track and no consumer but the engine. Publishing it as its own
// package would have offered the world a dependency that only makes sense here.
//
// Not re-exported from the package root, deliberately: these are the engine's
// internals, and a consumer reaching for `Operator` or `MultiSet` is reaching
// past the API this package means to keep.

export * from './d2.js'
export {
  DifferenceStreamReader,
  DifferenceStreamWriter,
  Operator,
  UnaryOperator,
  BinaryOperator,
  LinearUnaryOperator,
} from './graph.js'
export * from './multiset.js'
export * from './operators/index.js'
export * from './types.js'
export { compareKeys, serializeValue } from './utils.js'
