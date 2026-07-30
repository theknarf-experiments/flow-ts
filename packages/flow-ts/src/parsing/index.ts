// The parser. Grammar in `grammar.peggy`, generated into `__generated__/` by
// `pnpm build:grammar`, wrapped by `parser.ts` so the AST builders stay in TS.
//
// Re-exported from the package root, so `parseProgram` is available as
// `import { parseProgram } from 'flow-ts'`.

export * from './parser.js'
