// An atom that passes the wrong number of arguments used to run: the plan
// read whatever columns it was handed, so a query with a typo in it returned
// rows that didn't match the names it gave them.

import { parseProgram } from '@flow-ts/parsing'
import { describe, expect, it } from 'vitest'
import { executeProgram } from '../../src/executing/index.js'

const program = (rules: string) =>
  parseProgram(
    `\
.in
.decl Link(src: string, dst: string)

.printsize
.decl Out(x: string)

.rule
${rules}
`,
    { grammarSource: 'inline' },
  )

const run = (rules: string) =>
  executeProgram(program(rules), new Map([['Link', [['a', 'b'] as never]]]), {}, () => {})

describe('atom arity', () => {
  it('names the relation, what it takes and what it was given', () => {
    expect(() => run('Out(src) :- Link(src).')).toThrow(
      /relation "Link" is declared with 2 columns, but an atom in a rule for "Out" passes 1/,
    )
  })

  it('counts a placeholder as an argument, since the plan reads a column for it', () => {
    expect(() => run('Out(src) :- Link(src, dst, _).')).toThrow(
      /relation "Link" is declared with 2 columns/,
    )
  })

  it('leaves heads alone, for now', () => {
    // A head that writes more columns than its declaration names is equally
    // suspect, but the bundled examples do it — cc.dl declares CC2 with one
    // column and writes two — so this doesn't rule on it.
    expect(() => run('Out(src, dst) :- Link(src, dst).')).not.toThrow()
  })

  it('leaves a correct program alone', () => {
    expect(() => run('Out(src) :- Link(src, dst).')).not.toThrow()
  })

  it('says nothing about a relation whose shape is left to its rules', () => {
    // `.decl X()` is a placeholder, not a claim that X is nullary.
    const source = `\
.in
.decl Link(src: string, dst: string)

.printsize
.decl Loose()

.rule
Loose(src, dst) :- Link(src, dst).
`
    expect(() =>
      executeProgram(
        parseProgram(source, { grammarSource: 'inline' }),
        new Map([['Link', [['a', 'b'] as never]]]),
        {},
        () => {},
      ),
    ).not.toThrow()
  })
})
