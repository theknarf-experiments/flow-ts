// Public umbrella entry point. Re-exports the AST module plus the
// merged executor modules (strata, catalog, optimizing, planning,
// reading, executing). They used to be six separate workspace
// packages; collapsing them into a single package matches how they
// actually compose at runtime and keeps consumer imports simple.
//
// Parsing is in here too, as of the same reasoning applied once more.
// It was a separate package on the grounds that it has a build step
// (the peggy grammar) and that a consumer might bring its own syntax.
// But the parser needs the AST, the AST belongs with the executor
// that consumes it, and the executor's own tests need a parser to
// write programs in — a cycle no split of two packages resolves.

export * from './ast/index.js'
export * from './strata/index.js'
export * from './catalog/index.js'
export * from './optimizing/index.js'
export * from './planning/index.js'
export * from './reading/index.js'
export * from './executing/index.js'
export * from './typing/index.js'
export * from './shadow/index.js'
export * from './parsing/index.js'
