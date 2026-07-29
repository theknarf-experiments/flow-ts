// Targeted tests for the more interesting parser features: negation,
// comparisons, arithmetic, aggregation, constants, and rule optimisation hints.

import { Aggregation, Arithmetic, ComparisonExpr, programToDl } from 'flow-ts'
import { describe, expect, it } from 'vitest'
import { parseProgram } from '../src/index.js'

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
      value: { kind: 'Integer', value: 42 },
    })
  })

  it('parses negative integer literals', () => {
    const r = parseRule('R(x, y) :- A(x, -7).')
    const arg = (r.rhs[0]! as { kind: 'Atom'; atom: { args: unknown[] } }).atom.args[1]
    expect(arg).toMatchObject({
      kind: 'Const',
      value: { kind: 'Integer', value: -7 },
    })
  })

  it('parses placeholders (_)', () => {
    const r = parseRule('R(x, y) :- A(x, _).')
    const arg = (r.rhs[0]! as { kind: 'Atom'; atom: { args: unknown[] } }).atom.args[1]
    expect(arg).toMatchObject({ kind: 'Placeholder' })
  })

  it('parses string literals in atom args', () => {
    const r = parseRule('R(x) :- A(x, "alice").')
    const arg = (r.rhs[0]! as { kind: 'Atom'; atom: { args: unknown[] } }).atom.args[1]
    expect(arg).toMatchObject({
      kind: 'Const',
      value: { kind: 'Text', value: 'alice' },
    })
  })

  it('parses float literals in atom args', () => {
    const r = parseRule('R(x) :- A(x, 3.14).')
    const arg = (r.rhs[0]! as { kind: 'Atom'; atom: { args: unknown[] } }).atom.args[1]
    expect(arg).toMatchObject({
      kind: 'Const',
      value: { kind: 'Float', value: 3.14 },
    })
  })

  it('parses negative float literals', () => {
    const r = parseRule('R(x) :- A(x, -0.5).')
    const arg = (r.rhs[0]! as { kind: 'Atom'; atom: { args: unknown[] } }).atom.args[1]
    expect(arg).toMatchObject({
      kind: 'Const',
      value: { kind: 'Float', value: -0.5 },
    })
  })

  it('still parses bare integers as Integer (not Float)', () => {
    // The Float rule requires a `.`; `42` alone stays Integer.
    const r = parseRule('R(x) :- A(x, 42).')
    const arg = (r.rhs[0]! as { kind: 'Atom'; atom: { args: unknown[] } }).atom.args[1]
    expect(arg).toMatchObject({
      kind: 'Const',
      value: { kind: 'Integer', value: 42 },
    })
  })
})

describe('declarations', () => {
  it('parses .decl with a float column', () => {
    const program = parseProgram(`\
.in
.decl Measure(id: number, value: float)

.out
.decl Pass(id: number)

.rule
Pass(id) :- Measure(id, _).
`)
    expect(program.edbs[0]!.attributes[1]!.dataType).toBe('Float')
  })

  it('parses .decl with a string column', () => {
    const program = parseProgram(`\
.in
.decl Person(id: number, name: string)

.out
.decl Pass(id: number)

.rule
Pass(id) :- Person(id, _).
`)
    expect(program.edbs[0]!.attributes[1]!.dataType).toBe('String')
  })

  it('parses .decl with an any column', () => {
    const program = parseProgram(`\
.in
.decl Prop(entity: string, key: string, value: any)

.out
.decl Pass(entity: string)

.rule
Pass(e) :- Prop(e, _, _).
`)
    expect(program.edbs[0]!.attributes[2]!.dataType).toBe('Any')
  })

  it('serializes an any column back to `any`, so the round trip holds', () => {
    // The shadow compiler builds its `Seed_` declarations by re-emitting types
    // and parsing the result, so a type that doesn't survive this is a type the
    // backward path can't carry.
    const source = `\
.in
.decl Prop(entity: string, key: string, value: any)

.out
.decl V(v: any)

.rule
V(v) :- Prop(e, k, v).
`
    const once = programToDl(parseProgram(source))
    expect(once).toContain('value: any')
    expect(programToDl(parseProgram(once))).toBe(once)
  })

  it('still rejects a type it does not know', () => {
    expect(() =>
      parseProgram(`\
.in
.decl R(x: whatever)

.out
.decl P(x: number)

.rule
P(x) :- R(x).
`),
    ).toThrow()
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

// Queries: a rule that brings its own head declaration.
//
//     ?- Payroll(d, sum(s)) :- Person(i, n, d), Salary(i, s).
//
// Pure sugar. It desugars to `.decl Payroll()` plus the rule — a declaration
// the language already had, since `.decl Foo()` leaves the schema to the rules
// and `inferRelationTypes` recovers it when something needs it. So these tests
// are mostly about the *shape* of the desugaring, because everything after the
// parser sees an ordinary program.
describe('query rules', () => {
  const EDB = `\
.in
.decl A(x: number)
.decl B(x: number)
`

  it('declares its own head, with the schema left to the rule', () => {
    const program = parseProgram(`${EDB}\n?- Q(x) :- A(x).\n`)
    expect(program.idbs.map((d) => d.name)).toEqual(['Q'])
    expect(program.idbs[0]!.attributes).toEqual([])
    expect(program.rules).toHaveLength(1)
    expect(program.rules[0]!.head.name).toBe('Q')
  })

  it('needs no section header of its own', () => {
    // The `.out` / `.printsize` line is exactly the boilerplate this removes.
    expect(() => parseProgram(`${EDB}\n?- Q(x) :- A(x).\n`)).not.toThrow()
  })

  it('declares the head once when several rules share it', () => {
    // Two rules, one relation — which is how a query writes a union.
    const program = parseProgram(`${EDB}\n?- U(x) :- A(x).\n?- U(x) :- B(x).\n`)
    expect(program.idbs.map((d) => d.name)).toEqual(['U'])
    expect(program.rules).toHaveLength(2)
  })

  it('defers to an explicit declaration of the same name', () => {
    // A `.decl` is a statement; the query is shorthand for not having made one.
    const program = parseProgram(`${EDB}\n.out\n.decl U(v: number)\n\n?- U(x) :- A(x).\n`)
    expect(program.idbs).toHaveLength(1)
    expect(program.idbs[0]!.attributes.map((a) => a.name)).toEqual(['v'])
  })

  it('sits alongside ordinary declared rules', () => {
    const program = parseProgram(
      `${EDB}\n.out\n.decl N(x: number)\n\nN(x) :- A(x).\n\n?- Q(x) :- B(x).\n`,
    )
    expect(program.idbs.map((d) => d.name).sort()).toEqual(['N', 'Q'])
    expect(program.rules).toHaveLength(2)
  })

  it('takes the same optimisation hints as any other rule', () => {
    const program = parseProgram(`${EDB}\n?- Q(x) :- A(x), B(x). .optimize\n`)
    expect(program.rules[0]!.isPlanning).toBe(true)
    expect(program.rules[0]!.isSip).toBe(true)
  })

  it('carries aggregates, negation and comparisons like any other body', () => {
    const program = parseProgram(
      `${EDB}\n?- Q(x, count(y)) :- A(x), B(y), !A(y), y > 1.\n`,
    )
    expect(program.rules[0]!.head.headArguments[1]!.kind).toBe('Aggregation')
    expect(program.rules[0]!.rhs).toHaveLength(4)
  })

  it('serializes back to the declaration and the rule, and round-trips', () => {
    // The sugar is not preserved, because nothing downstream distinguishes it.
    const once = programToDl(parseProgram(`${EDB}\n?- Q(x) :- A(x).\n`))
    expect(once).toContain('.decl Q()')
    expect(once).toContain('Q(x) :- A(x).')
    expect(once).not.toContain('?-')
    expect(programToDl(parseProgram(once))).toBe(once)
  })
})

// The bare form: Prolog's "show me the answers", with no head at all.
//
//     ?- Person(i, n, d), Salary(i, s), s > 100.
//
// The head is built from the body: the distinct variables its positive atoms
// bind, in order of first appearance. The name is made up, and that is the
// point — a query you are about to throw away should not have to be christened.
describe('bare query goals', () => {
  const EDB = `\
.in
.decl A(x: number)
.decl P(id: number, name: string)
`

  it('reports the variables the body binds, in order', () => {
    const program = parseProgram(`${EDB}\n?- P(i, n).\n`)
    expect(program.rules).toHaveLength(1)
    expect(program.rules[0]!.head.name).toBe('Query1')
    expect(program.rules[0]!.head.headArguments).toEqual([
      { kind: 'Var', name: 'i' },
      { kind: 'Var', name: 'n' },
    ])
    // Declared like any other query — schema left to the rule.
    expect(program.idbs.map((d) => d.name)).toEqual(['Query1'])
    expect(program.idbs[0]!.attributes).toEqual([])
  })

  it('takes each variable once, across every positive atom', () => {
    const program = parseProgram(`${EDB}\n?- P(i, n), A(i).\n`)
    expect(program.rules[0]!.head.headArguments).toEqual([
      { kind: 'Var', name: 'i' },
      { kind: 'Var', name: 'n' },
    ])
  })

  it('projects with `_`, which binds nothing', () => {
    const program = parseProgram(`${EDB}\n?- P(_, n).\n`)
    expect(program.rules[0]!.head.headArguments).toEqual([{ kind: 'Var', name: 'n' }])
  })

  it('ignores variables a negated atom or comparison mentions', () => {
    // Those are bound positively or not at all; reporting an unbound one would
    // be reporting nothing.
    const program = parseProgram(`${EDB}\n?- P(i, n), !A(i), i > 1.\n`)
    expect(program.rules[0]!.head.headArguments).toEqual([
      { kind: 'Var', name: 'i' },
      { kind: 'Var', name: 'n' },
    ])
  })

  it('numbers several goals in source order', () => {
    const program = parseProgram(`${EDB}\n?- P(_, n).\n?- A(x).\n`)
    expect(program.rules.map((r) => r.head.name)).toEqual(['Query1', 'Query2'])
  })

  it('steps around a real relation that happens to be called Query1', () => {
    // The generated name is a throwaway, so it gives way rather than colliding.
    const program = parseProgram(`.in\n.decl Query1(x: number)\n.decl B(x: number)\n\n?- B(y).\n`)
    expect(program.rules[0]!.head.name).toBe('Query2')
  })

  it('mixes with the named form, numbering only the bare ones', () => {
    const program = parseProgram(`${EDB}\n?- Named(x) :- A(x).\n?- P(_, n).\n`)
    expect(program.rules.map((r) => r.head.name)).toEqual(['Named', 'Query1'])
  })

  it('refuses a goal that binds nothing, and says what to do', () => {
    // `?- P(1, "alice").` is a yes/no question with no columns to show.
    expect(() => parseProgram(`${EDB}\n?- P(1, "alice").\n`)).toThrow(/binds none/)
  })

  it('serializes to the generated name, and round-trips', () => {
    const once = programToDl(parseProgram(`${EDB}\n?- P(_, n).\n`))
    expect(once).toContain('.decl Query1()')
    expect(once).toContain('Query1(n) :- P(_, n).')
    expect(programToDl(parseProgram(once))).toBe(once)
  })

  it('serializes back to the declaration and the rule, and round-trips', () => {
    // The sugar is not preserved, because nothing downstream distinguishes it.
    const once = programToDl(parseProgram(`${EDB}\n?- Q(x) :- A(x).\n`))
    expect(once).toContain('.decl Q()')
    expect(once).toContain('Q(x) :- A(x).')
    expect(once).not.toContain('?-')
    expect(programToDl(parseProgram(once))).toBe(once)
  })
})
