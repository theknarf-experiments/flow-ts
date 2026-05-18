// Targeted parser tests on reach.dl — the simplest end-to-end Datalog program.

import { describe, expect, it } from 'vitest'
import { parseProgram } from '../src/index.js'

const REACH = `\
.in
.decl Source(id: number)
.input Source.csv

.decl Arc(x: number, y: number)
.input Arc.csv

.printsize
.decl Reach(id: number)

.rule
Reach(y) :- Source(y).
Reach(y) :- Reach(x), Arc(x,y).
`

describe('reach.dl', () => {
  const program = parseProgram(REACH)

  it('parses two EDB relations', () => {
    expect(program.edbs).toHaveLength(2)
    expect(program.edbs.map((e) => e.name)).toEqual(['Source', 'Arc'])
  })

  it('records input file paths on EDBs', () => {
    expect(program.edbs[0]!.path).toBe('Source.csv')
    expect(program.edbs[1]!.path).toBe('Arc.csv')
  })

  it('captures attribute arities', () => {
    expect(program.edbs[0]!.arity()).toBe(1)
    expect(program.edbs[1]!.arity()).toBe(2)
  })

  it('parses one IDB relation', () => {
    expect(program.idbs).toHaveLength(1)
    expect(program.idbs[0]!.name).toBe('Reach')
    expect(program.idbs[0]!.arity()).toBe(1)
  })

  it('parses two rules', () => {
    expect(program.rules).toHaveLength(2)
  })

  it('rule heads are Reach(y)', () => {
    for (const rule of program.rules) {
      expect(rule.head.name).toBe('Reach')
      expect(rule.head.arity()).toBe(1)
      expect(rule.head.headArguments[0]).toMatchObject({ kind: 'Var', name: 'y' })
    }
  })

  it('second rule body has two atom predicates', () => {
    const rule = program.rules[1]!
    expect(rule.rhs).toHaveLength(2)
    expect(rule.rhs[0]).toMatchObject({ kind: 'Atom' })
    expect(rule.rhs[1]).toMatchObject({ kind: 'Atom' })
    if (rule.rhs[0]!.kind === 'Atom') {
      expect(rule.rhs[0]!.atom.name).toBe('Reach')
    }
    if (rule.rhs[1]!.kind === 'Atom') {
      expect(rule.rhs[1]!.atom.name).toBe('Arc')
    }
  })
})
