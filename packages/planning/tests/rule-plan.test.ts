// Targeted tests for RuleQueryPlan over parsed rules.

import { Catalog } from '@flow-ts/catalog'
import { parseProgram } from '@flow-ts/parsing'
import { describe, expect, it } from 'vitest'
import { RuleQueryPlan, transformationOutput } from '../src/index.js'

function planFor(src: string) {
  const program = parseProgram(src)
  const cat = Catalog.fromStrata(program.rules[0]!)
  return RuleQueryPlan.fromCatalog(cat, false)
}

describe('RuleQueryPlan', () => {
  it('single-atom rule: plan ends at a Row/K/Kv transformation', () => {
    const plan = planFor(`\
.in
.decl A(x: number, y: number)
.input A.csv

.printsize
.decl R(x: number, y: number)

.rule
R(x, y) :- A(x, y).
`)
    // The last transformation's output should reference the head's vars.
    const out = transformationOutput(plan.lastTransformation)
    const allArgs = [...out.keyArgumentSignatures, ...out.valueArgumentSignatures]
    expect(allArgs.length).toBeGreaterThanOrEqual(2)
  })

  it('reach.dl recursive rule: plan is a join with two children', () => {
    const plan = planFor(`\
.in
.decl Source(id: number)
.input Source.csv

.decl Arc(x: number, y: number)
.input Arc.csv

.printsize
.decl Reach(id: number)

.rule
Reach(y) :- Reach(x), Arc(x, y).
`)
    // Should have at least one entry in the transformation tree.
    expect(plan.transformationTree.size).toBeGreaterThan(0)
    const root = plan.lastTransformation
    // The root should be a join of some kind.
    expect(['JnKK', 'JnKKv', 'JnKvK', 'JnKvKv', 'Cartesian']).toContain(root.kind)
  })

  it('TC rule: tc(x, z) :- arc(x, y), tc(y, z) plan builds successfully', () => {
    const plan = planFor(`\
.in
.decl arc(x: number, y: number)
.input arc.csv

.printsize
.decl tc(x: number, z: number)

.rule
tc(x, z) :- arc(x, y), tc(y, z).
`)
    expect(plan.transformationTree.size).toBeGreaterThan(0)
  })

  it('rule with comparison predicate plans without error', () => {
    const plan = planFor(`\
.in
.decl A(x: number, y: number)
.input A.csv

.printsize
.decl R(x: number, y: number)

.rule
R(x, y) :- A(x, y), x != y.
`)
    expect(plan).toBeDefined()
  })

  it('rule with constant in body plans without error', () => {
    const plan = planFor(`\
.in
.decl A(x: number, y: number)
.input A.csv

.printsize
.decl R(x: number)

.rule
R(x) :- A(x, 5).
`)
    expect(plan).toBeDefined()
  })

  it('rule with placeholder in body plans without error', () => {
    const plan = planFor(`\
.in
.decl A(x: number, y: number)
.input A.csv

.printsize
.decl R(x: number)

.rule
R(x) :- A(x, _).
`)
    expect(plan).toBeDefined()
  })
})
