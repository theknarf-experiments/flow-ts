// Rules whose head computes a value.
//
// `S(x + 1) :- R(x).` used to refuse the whole rule — not just the computed
// column, but deletion too, which never needed an inverse at all. Deleting a
// derived row only asks which source tuple produced it, and that is answerable
// by binding the computed position to a variable and replaying the computation
// as a filter:
//
//   Del_R(x) :- Del_S(h0), R(x), h0 == x + 1.
//
// Updating the computed column is the part that genuinely needs an inverse, and
// only some arithmetic has one. `x + c`, `x - c`, `c - x` and `x * c` invert
// exactly; `/` and `%` are not injective — many inputs give the same output, so
// there is no principled choice of which to write back — and are refused.
//
// Multiplication is a caveat worth stating: its inverse is division, which
// truncates, so a request that isn't divisible produces a value that doesn't
// round-trip. The verify step catches that and reports `unsatisfied`, which is
// the whole reason the protocol verifies rather than trusting.

import { describe, expect, it } from 'vitest'
import { parseProgram } from '@flow-ts/parsing'
import type { Row } from '../../src/reading/index.js'
import { compileShadow, resolveBackward } from '../../src/shadow/index.js'
import type { Facts } from './_harness.js'

const PARSE = { parse: (src: string) => parseProgram(src, { grammarSource: 's.dl' }), views: 'all' as const }

function ruleLines(source: string): string[] {
  const at = source.indexOf('.rule')
  return source
    .slice(at + '.rule'.length)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

const prog = (rule: string) =>
  parseProgram(
    `\
.in
.decl R(x: number)
.input R.csv

.printsize
.decl S(y: number)

.rule
${rule}
`,
    { grammarSource: 'h.dl' },
  )

const FACTS: Facts = { R: [[1], [5]] }

describe('deletion needs no inverse', () => {
  it('binds the computed column and replays the computation', () => {
    const lines = ruleLines(compileShadow(prog('S(x + 1) :- R(x).')).source)
    expect(lines.some((l) => /^Del_R\(x\) :- Del_S\(\w+\), R\(x\), \w+ == x \+ 1\.$/.test(l))).toBe(
      true,
    )
  })

  it('resolves to the row that produced the value', () => {
    const r = resolveBackward(prog('S(x + 1) :- R(x).'), FACTS, { rel: 'S', row: [6] }, PARSE)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.changes).toEqual([{ kind: 'del', rel: 'R', row: [5] }])
  })

  it('works for arithmetic that has no inverse at all', () => {
    // `%` is hopeless to invert, but deleting still only asks which row it was.
    const r = resolveBackward(prog('S(x % 3) :- R(x).'), { R: [[7]] }, { rel: 'S', row: [1] }, PARSE)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.changes).toEqual([{ kind: 'del', rel: 'R', row: [7] }])
  })
})

describe('updating the computed column', () => {
  it.each([
    ['S(x + 1) :- R(x).', 6, 10, 9],
    ['S(x - 1) :- R(x).', 4, 10, 11],
    ['S(10 - x) :- R(x).', 5, 2, 8],
    ['S(x * 2) :- R(x).', 10, 14, 7],
  ])('%s: %i → %i writes back %i', (rule, from, to, expected) => {
    const r = resolveBackward(prog(rule), FACTS, { rel: 'S', row: [from], newRow: [to] }, PARSE)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.changes).toEqual([{ kind: 'upd', rel: 'R', row: [5], newRow: [expected] }])
  })

  it('reports an inexact inverse rather than writing a wrong value', () => {
    // 5*2 = 10; asking for 11 would need x = 5.5, and the column is an integer.
    const r = resolveBackward(
      prog('S(x * 2) :- R(x).'),
      FACTS,
      { rel: 'S', row: [10], newRow: [11] },
      PARSE,
    )
    expect(r.status).toBe('unsatisfied')
  })

  it('refuses division, which is not injective', () => {
    const shadow = compileShadow(prog('S(x / 2) :- R(x).'))
    expect(shadow.refusals.some((r) => /not injective|no inverse|Divide/i.test(r.reason))).toBe(
      true,
    )
    // …but deletion is still available.
    expect(ruleLines(shadow.source).some((l) => l.startsWith('Del_R('))).toBe(true)
  })

  it('refuses multi-step arithmetic, which needs helper relations', () => {
    const shadow = compileShadow(prog('S(x + 1 * 2) :- R(x).'))
    expect(shadow.refusals.some((r) => /single operation|one operation/i.test(r.reason))).toBe(true)
  })

  it('refuses when the computed column depends on more than one variable', () => {
    const p = parseProgram(
      `\
.in
.decl R(x: number, z: number)
.input R.csv

.printsize
.decl S(y: number)

.rule
S(x + z) :- R(x, z).
`,
      { grammarSource: 'm.dl' },
    )
    const shadow = compileShadow(p)
    expect(shadow.refusals.some((r) => /one variable|two variables|underdetermined/i.test(r.reason)))
      .toBe(true)
  })
})

describe('other columns of the same head are unaffected', () => {
  it('a plain column still rewrites directly', () => {
    const p = parseProgram(
      `\
.in
.decl R(name: string, x: number)
.input R.csv

.printsize
.decl S(name: string, y: number)

.rule
S(n, x + 1) :- R(n, x).
`,
      { grammarSource: 'p.dl' },
    )
    const facts: Facts = { R: [['a', 5]] }
    const r = resolveBackward(p, facts, { rel: 'S', row: ['a', 6], newRow: ['b', 6] }, PARSE)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.changes).toEqual([
      { kind: 'upd', rel: 'R', row: ['a', 5], newRow: ['b', 5] } as unknown as Row,
    ])
  })
})
