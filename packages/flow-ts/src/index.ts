// Public umbrella entry point. Re-exports the AST module plus the
// merged executor modules (strata, catalog, optimizing, planning,
// reading, executing). They used to be six separate workspace
// packages; collapsing them into a single package matches how they
// actually compose at runtime and keeps consumer imports simple.
//
// The split between this package and `@flow-ts/parsing` is real:
// parsing has a build step (the peggy grammar) and consumers may
// want to bring their own syntax or build programs programmatically,
// so it stays its own package. The AST types live here because the
// executor is their primary consumer; the parser depends on us.

export * from './ast/index.js'
export * from './strata/index.js'
export * from './catalog/index.js'
export * from './optimizing/index.js'
export * from './planning/index.js'
export * from './reading/index.js'
export * from './executing/index.js'
