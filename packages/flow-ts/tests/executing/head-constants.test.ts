// A rule head may carry a constant, and it doesn't have to be a number.
// Head arguments are compiled as arithmetic expressions, so a bare
// `"literal"` used to reach the numeric evaluator and fail with an error
// about arithmetic — nowhere near the rule that wrote it.

import { parseProgram } from '@flow-ts/parsing'
import { describe, expect, it } from 'vitest'
import { executeProgram } from '../../src/executing/index.js'
import type { Row } from '../../src/reading/index.js'

function run(source: string, edbs: Record<string, Row[]>): Array<[string, Row]> {
  const out: Array<[string, Row]> = []
  executeProgram(
    parseProgram(source, { grammarSource: 'inline' }),
    new Map(Object.entries(edbs)),
    {},
    (rel, row, mult) => {
      if (mult > 0) out.push([rel, [...row] as Row])
    },
  )
  return out
}

const SOURCE = `\
.in
.decl Link(src: string, dst: string)

.printsize
.decl Kind()
.decl Weighted()

.rule
Kind(src, dst, "wiki") :- Link(src, dst).
Weighted(src, 1) :- Link(src, dst).
`

describe('constants in a rule head', () => {
  it('carries a string through as itself', () => {
    const rows = run(SOURCE, { Link: [['a.md', 'b.md'] as unknown as Row] })
    expect(rows).toContainEqual(['Kind', ['a.md', 'b.md', 'wiki']])
  })

  it('still evaluates numeric ones as arithmetic', () => {
    const rows = run(SOURCE, { Link: [['a.md', 'b.md'] as unknown as Row] })
    expect(rows).toContainEqual(['Weighted', ['a.md', 1]])
  })
})
