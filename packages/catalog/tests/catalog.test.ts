// End-to-end Catalog tests on parsed .dl programs.

import { parseProgram } from '@flow-ts/parsing'
import { describe, expect, it } from 'vitest'
import { Catalog } from '../src/index.js'

function parseSingleRule(rule: string) {
  const src = `\
.in
.decl A(x: number, y: number)
.input A.csv

.printsize
.decl R(x: number, y: number)

.rule
${rule}
`
  const program = parseProgram(src)
  return program.rules[0]!
}

describe('Catalog.fromStrata on reach.dl recursive rule', () => {
  const program = parseProgram(`\
.in
.decl Source(id: number)
.input Source.csv

.decl Arc(x: number, y: number)
.input Arc.csv

.printsize
.decl Reach(id: number)

.rule
Reach(y) :- Source(y).
Reach(y) :- Reach(x), Arc(x, y).
`)
  const cat = Catalog.fromStrata(program.rules[1]!)

  it('lists positive atom names in body order', () => {
    expect(cat.atomNames).toEqual(['Reach', 'Arc'])
  })

  it('has no negated atoms', () => {
    expect(cat.negatedAtomNames).toEqual([])
  })

  it('records two argument signatures per atom', () => {
    expect(cat.atomArgumentSignatures[0]!.map((s) => s.toString())).toEqual(['0.0'])
    expect(cat.atomArgumentSignatures[1]!.map((s) => s.toString())).toEqual([
      '1.0',
      '1.1',
    ])
  })

  it('builds the argument_presence_map across atoms', () => {
    // Rule body is Reach(x), Arc(x, y).
    //   x in Reach@0 → 0.0  and  Arc@0 → 1.0
    //   y in Arc@1   → 1.1 only
    expect(cat.argumentPresenceMap.get('x')?.map((p) => p?.toString() ?? null)).toEqual([
      '0.0',
      '1.0',
    ])
    expect(cat.argumentPresenceMap.get('y')?.map((p) => p?.toString() ?? null)).toEqual([
      null,
      '1.1',
    ])
  })

  it('marks the smaller-argument-set atom as non-core', () => {
    // Reach(x) has args {x}; Arc(x, y) has args {x, y} — Reach is non-core.
    expect(cat.isCoreAtomBitmap).toEqual([false, true])
  })

  it('exposes dependent atom names', () => {
    expect([...cat.dependentAtomNames()].sort()).toEqual(['Arc', 'Reach'])
  })

  it('exposes head argument map keyed by string form', () => {
    expect(cat.headArgumentsMap.size).toBe(1)
    expect(cat.headArgumentsMap.has('y')).toBe(true)
  })
})

describe('Catalog comparison predicates', () => {
  it('captures comparison predicates and their variable sets', () => {
    const rule = parseSingleRule('R(x, y) :- A(x, y), x != y.')
    const cat = Catalog.fromStrata(rule)
    expect(cat.comparisonPredicates).toHaveLength(1)
    const vars = cat.comparisonPredicatesVarsSet[0]!
    expect([...vars].sort()).toEqual(['x', 'y'])
  })
})

describe('Catalog.subAtoms / subNegatedAtoms', () => {
  it('returns non-core atoms whose arg set is a subset of the given args', () => {
    // Two body atoms with one subset of the other.
    // P(x) :- A(x), B(x, y).  → A's args {x} ⊆ B's args {x,y}  → A is non-core.
    const src = `\
.in
.decl A(x: number)
.input A.csv

.decl B(x: number, y: number)
.input B.csv

.printsize
.decl P(x: number)

.rule
P(x) :- A(x), B(x, y).
`
    const program = parseProgram(src)
    const cat = Catalog.fromStrata(program.rules[0]!)
    expect(cat.isCoreAtomBitmap).toEqual([false, true])

    // sub_atoms relative to the args of B should include A.
    const bArgs = cat.atomArgumentSignatures[1]!
    const subs = cat.subAtoms(bArgs).map((s) => s.toString())
    expect(subs).toEqual(['0'])
  })
})

describe('Catalog vars_set / negated_vars', () => {
  it('returns variable names from the named positive atoms only', () => {
    // R(x, y, z) :- A(x, y), B(y, z).
    const src = `\
.in
.decl A(x: number, y: number)
.input A.csv

.decl B(y: number, z: number)
.input B.csv

.printsize
.decl R(x: number, y: number, z: number)

.rule
R(x, y, z) :- A(x, y), B(y, z).
`
    const program = parseProgram(src)
    const cat = Catalog.fromStrata(program.rules[0]!)
    expect([...cat.varsSet([0])].sort()).toEqual(['x', 'y'])
    expect([...cat.varsSet([1])].sort()).toEqual(['y', 'z'])
    expect([...cat.varsSet([0, 1])].sort()).toEqual(['x', 'y', 'z'])
  })
})
