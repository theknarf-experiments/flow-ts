// Targeted tests for DependencyGraph against parsed .dl programs.

import { parseProgram } from '@flow-ts/parsing'
import { describe, expect, it } from 'vitest'
import { DependencyGraph } from '../../src/strata/index.js'

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
Reach(y) :- Reach(x), Arc(x, y).
`

describe('DependencyGraph', () => {
  it('captures self-dependency through the recursive Reach rule', () => {
    const program = parseProgram(REACH)
    const graph = DependencyGraph.fromParser(program)

    // Two rules, both heads named Reach.
    expect(graph.ruleIdbNames).toEqual(['Reach', 'Reach'])

    // Rule 0 (Reach(y) :- Source(y)) has no body atoms whose head is an IDB.
    expect([...graph.ruleDependencyMap.get(0)!]).toEqual([])

    // Rule 1 (Reach(y) :- Reach(x), Arc(x,y)) depends on both rules producing Reach (i.e. 0 and 1).
    expect([...graph.ruleDependencyMap.get(1)!].sort()).toEqual([0, 1])

    // No negation anywhere.
    expect([...graph.negationDependencyMap.get(0)!]).toEqual([])
    expect([...graph.negationDependencyMap.get(1)!]).toEqual([])
  })

  it('records negation edges when a body atom is negated', () => {
    const src = `\
.in
.decl A(x: number)
.input A.csv

.printsize
.decl R(x: number)
.decl S(x: number)

.rule
R(x) :- A(x).
S(x) :- A(x), !R(x).
`
    const program = parseProgram(src)
    const graph = DependencyGraph.fromParser(program)
    // Rule 1 (S) negates R (rule 0).
    expect([...graph.negationDependencyMap.get(1)!]).toEqual([0])
    // ... and also has it as a regular dependency.
    expect([...graph.ruleDependencyMap.get(1)!]).toEqual([0])
  })
})
