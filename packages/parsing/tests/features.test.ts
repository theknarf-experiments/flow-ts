// Targeted tests for the more interesting parser features: negation,
// comparisons, arithmetic, aggregation, constants, and rule optimisation hints.

import { describe, expect, it } from 'vitest'
import {
  Aggregation,
  Arithmetic,
  ComparisonExpr,
  parseProgram,
} from '../src/index.js'

const HEADER = `\
.in
.decl A(x: number, y: number)
.input A.csv

.printsize
.decl R(x: number, y: number)
`

function parseRule(rule: string) {
  return parseProgram(`${HEADER}\n.rule\n${rule}\n`).rules[0]!
}

describe('negation', () => {
  it('parses !A(x, y) in the body', () => {
    const r = parseRule('R(x, y) :- A(x, y), !A(y, x).')
    expect(r.rhs).toHaveLength(2)
    expect(r.rhs[1]).toMatchObject({ kind: 'NegatedAtom' })
    if (r.rhs[1]!.kind === 'NegatedAtom') {
      expect(r.rhs[1]!.atom.name).toBe('A')
    }
  })
})

describe('comparisons', () => {
  it('parses all six comparison operators', () => {
    const ops = ['=', '!=', '>', '>=', '<', '<=']
    const expected = [
      'Equals',
      'NotEquals',
      'GreaterThan',
      'GreaterEqualThan',
      'LessThan',
      'LessEqualThan',
    ]
    for (let i = 0; i < ops.length; i++) {
      const r = parseRule(`R(x, y) :- A(x, y), x ${ops[i]} y.`)
      const cmp = r.rhs[1]
      expect(cmp).toBeDefined()
      if (cmp!.kind === 'Compare') {
        expect(cmp!.expr.operator).toBe(expected[i])
        expect(cmp!.expr).toBeInstanceOf(ComparisonExpr)
      } else {
        throw new Error(`expected Compare for operator ${ops[i]}`)
      }
    }
  })
})

describe('arithmetic', () => {
  it('parses x + y * z as a left-to-right arithmetic chain', () => {
    const r = parseRule('R(x, y) :- A(x, y), x + y > x * y.')
    const cmp = r.rhs[1]
    if (cmp!.kind !== 'Compare') throw new Error('expected compare')
    expect(cmp!.expr.left).toBeInstanceOf(Arithmetic)
    expect(cmp!.expr.left.rest).toHaveLength(1)
    expect(cmp!.expr.left.rest[0]![0]).toBe('Plus')
    expect(cmp!.expr.right.rest[0]![0]).toBe('Multiply')
  })
})

describe('aggregation', () => {
  const HEADER_AGG = `\
.in
.decl A(x: number, y: number)
.input A.csv

.printsize
.decl R(x: number, c: number)
`
  it('parses count() in the head', () => {
    const program = parseProgram(
      `${HEADER_AGG}\n.rule\nR(x, count(y)) :- A(x, y).\n`,
    )
    const r = program.rules[0]!
    expect(r.head.headArguments).toHaveLength(2)
    const last = r.head.headArguments[1]!
    expect(last.kind).toBe('Aggregation')
    if (last.kind === 'Aggregation') {
      expect(last.aggregation).toBeInstanceOf(Aggregation)
      expect(last.aggregation.operator).toBe('Count')
    }
  })

  it('parses sum/min/max in the head', () => {
    for (const op of ['sum', 'min', 'max'] as const) {
      const program = parseProgram(
        `${HEADER_AGG}\n.rule\nR(x, ${op}(y)) :- A(x, y).\n`,
      )
      const last = program.rules[0]!.head.headArguments[1]!
      if (last.kind !== 'Aggregation') throw new Error('expected aggregation')
      expect(last.aggregation.operator).toBe(
        op[0]!.toUpperCase() + op.slice(1),
      )
    }
  })
})

describe('constants', () => {
  it('parses integer literals in atom args', () => {
    const r = parseRule('R(x, y) :- A(x, 42).')
    const arg = (r.rhs[0]! as { kind: 'Atom'; atom: { args: unknown[] } }).atom.args[1]
    expect(arg).toMatchObject({
      kind: 'Const',
      value: { kind: 'Integer', value: 42n },
    })
  })

  it('parses negative integer literals', () => {
    const r = parseRule('R(x, y) :- A(x, -7).')
    const arg = (r.rhs[0]! as { kind: 'Atom'; atom: { args: unknown[] } }).atom.args[1]
    expect(arg).toMatchObject({
      kind: 'Const',
      value: { kind: 'Integer', value: -7n },
    })
  })

  it('parses placeholders (_)', () => {
    const r = parseRule('R(x, y) :- A(x, _).')
    const arg = (r.rhs[0]! as { kind: 'Atom'; atom: { args: unknown[] } }).atom.args[1]
    expect(arg).toMatchObject({ kind: 'Placeholder' })
  })
})

describe('optimisation hints', () => {
  it('parses .plan / .sip / .optimize', () => {
    const planRule = parseRule('R(x, y) :- A(x, y). .plan')
    expect(planRule.isPlanning).toBe(true)
    expect(planRule.isSip).toBe(false)
    const sipRule = parseRule('R(x, y) :- A(x, y). .sip')
    expect(sipRule.isPlanning).toBe(false)
    expect(sipRule.isSip).toBe(true)
    const bothRule = parseRule('R(x, y) :- A(x, y). .optimize')
    expect(bothRule.isPlanning).toBe(true)
    expect(bothRule.isSip).toBe(true)
  })
})

describe('comments', () => {
  it('skips // line comments', () => {
    const program = parseProgram(
      `${HEADER}\n// comment line\n.rule\nR(x, y) :- A(x, y). // trailing\n`,
    )
    expect(program.rules).toHaveLength(1)
  })

  it('skips # line comments', () => {
    const program = parseProgram(
      `${HEADER}\n# comment line\n.rule\nR(x, y) :- A(x, y).\n`,
    )
    expect(program.rules).toHaveLength(1)
  })
})

describe('multiple .printsize blocks', () => {
  it('parses sequential .printsize sections (galen-style)', () => {
    const src = `\
.in
.decl A(x: number)
.input A.csv

.printsize
.decl R1(x: number)

.printsize
.decl R2(x: number)

.rule
R1(x) :- A(x).
R2(x) :- R1(x).
`
    const program = parseProgram(src)
    expect(program.idbs).toHaveLength(2)
    expect(program.idbs.map((i) => i.name)).toEqual(['R1', 'R2'])
  })
})
