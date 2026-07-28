// `.put` — declaring the backward semantics the compiler can't infer.
//
// Everything the shadow compiler generates is forced by the rule that defines
// a relation. An aggregate isn't: inverting `sum` needs a distribution, and
// over the integers even the least-change distribution leaves a residual whose
// owner is a free choice. `.put` is where that choice is written down.
//
// It attaches to the relation's declaration, the way `.input` attaches to an
// EDB's — the policy is a property of what the relation *is*, not of the
// request that arrives later.

import { describe, expect, it } from 'vitest'
import { programToDl } from 'flow-ts'
import { parseProgram } from '../src/index.js'

const withPut = (put: string) => `\
.in
.decl Hours(p: string, w: number, h: number)
.input Hours.csv

.printsize
.decl Total(p: string, s: number)${put}

.rule
Total(p, sum(h)) :- Hours(p, w, h).
`

describe('parsing', () => {
  it('defaults to no policy', () => {
    const p = parseProgram(withPut(''))
    expect(p.idbs[0]!.put).toBeNull()
  })

  it('reads a spread policy with its residual', () => {
    const p = parseProgram(withPut('\n.put spread(min)'))
    expect(p.idbs[0]!.put).toEqual({ kind: 'spread', residual: 'min' })
  })

  it('reads max as the residual too', () => {
    const p = parseProgram(withPut('\n.put spread(max)'))
    expect(p.idbs[0]!.put).toEqual({ kind: 'spread', residual: 'max' })
  })

  it('reads an explicit read-only marking', () => {
    const p = parseProgram(withPut('\n.put none'))
    expect(p.idbs[0]!.put).toEqual({ kind: 'none' })
  })

  it('rejects an unknown policy rather than ignoring it', () => {
    expect(() => parseProgram(withPut('\n.put wishful'))).toThrow()
  })

  it('rejects a spread without a residual — the choice is the point', () => {
    expect(() => parseProgram(withPut('\n.put spread'))).toThrow()
  })

  it('does not apply to EDB declarations', () => {
    expect(() =>
      parseProgram(`\
.in
.decl Hours(p: string, w: number, h: number)
.put spread(min)

.printsize
.decl Total(p: string, s: number)

.rule
Total(p, sum(h)) :- Hours(p, w, h).
`),
    ).toThrow()
  })
})

describe('serialization', () => {
  it('round-trips through programToDl', () => {
    for (const put of ['', '\n.put spread(min)', '\n.put spread(max)', '\n.put none']) {
      const once = parseProgram(withPut(put))
      const twice = parseProgram(programToDl(once), { grammarSource: 'rt.dl' })
      expect(twice.idbs[0]!.put).toEqual(once.idbs[0]!.put)
    }
  })

  it('emits the directive', () => {
    expect(programToDl(parseProgram(withPut('\n.put spread(min)')))).toContain('.put spread(min)')
  })
})
