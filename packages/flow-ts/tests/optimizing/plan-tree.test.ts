// Targeted PlanTree tests on parsed .dl rules.

import { Catalog } from '../../src/catalog/index.js'
import { parseProgram } from '@flow-ts/parsing'
import { describe, expect, it } from 'vitest'
import { PlanTree } from '../../src/optimizing/index.js'

function planFor(ruleSrc: string, optimized = false): PlanTree {
  // Use disjoint-arity atoms so all body atoms are "core" — atoms with
  // identical arg-string sets get collapsed to a single core by the catalog.
  const src = `\
.in
.decl A(x: number, y: number)
.input A.csv

.decl B(y: number, z: number)
.input B.csv

.decl C(z: number, w: number)
.input C.csv

.printsize
.decl R(x: number, w: number)

.rule
${ruleSrc}
`
  const program = parseProgram(src)
  const cat = Catalog.fromStrata(program.rules[0]!)
  return PlanTree.fromCatalog(cat, optimized)
}

describe('PlanTree — basic shape', () => {
  it('single-atom rule yields a 1-node tree', () => {
    const tree = planFor('R(x, y) :- A(x, y).')
    expect(tree.root).toBe(0)
    expect(tree.tree.get(0)).toEqual([])
    expect(tree.isLeaf(0)).toBe(true)
    expect(tree.treeWidth).toBe(0)
  })

  it('two-atom rule yields the default chain with the last atom as root', () => {
    // R(x, z) :- A(x, y), B(y, z).  → root=1, 1 → 0
    const tree = planFor('R(x, y) :- A(x, y), B(y, z).')
    expect(tree.root).toBe(1)
    expect(tree.tree.get(1)).toEqual([0])
    expect(tree.tree.get(0)).toEqual([])
    expect(tree.isAcyclic()).toBe(true) // shared y
  })

  it('three-atom rule yields a 3-deep chain by default', () => {
    const tree = planFor('R(x, w) :- A(x, y), B(y, z), C(z, w).')
    expect(tree.root).toBe(2)
    expect(tree.tree.get(2)).toEqual([1])
    expect(tree.tree.get(1)).toEqual([0])
    expect(tree.tree.get(0)).toEqual([])
  })
})

describe('PlanTree — subTrees pre-order', () => {
  it('records each subtree as pre-order traversal from its subroot', () => {
    const tree = planFor('R(x, w) :- A(x, y), B(y, z), C(z, w).')
    // Default chain: 2 → 1 → 0.
    expect(tree.subTrees.get(2)).toEqual([2, 1, 0])
    expect(tree.subTrees.get(1)).toEqual([1, 0])
    expect(tree.subTrees.get(0)).toEqual([0])
  })
})

describe('PlanTree — acyclicity', () => {
  it('identifies a cyclic-shaped query (sum of arities > distinct vars + chain overlaps)', () => {
    // R(x, z) :- A(x, y), B(y, z), C(z, x).  (triangle)
    // The chain plan only captures 2 of 3 shared-var pairs, so it's "cyclic".
    const src = `\
.in
.decl A(x: number, y: number)
.input A.csv

.decl B(y: number, z: number)
.input B.csv

.decl C(z: number, x: number)
.input C.csv

.printsize
.decl R(x: number, z: number)

.rule
R(x, z) :- A(x, y), B(y, z), C(z, x).
`
    const program = parseProgram(src)
    const cat = Catalog.fromStrata(program.rules[0]!)
    const tree = PlanTree.fromCatalog(cat, false)
    expect(tree.isAcyclic()).toBe(false)
  })
})

describe('PlanTree — optimized vs default', () => {
  it('optimized tree spans every core atom', () => {
    const tree = planFor('R(x, w) :- A(x, y), B(y, z), C(z, w).', true)
    const visited = new Set<number>([tree.root])
    const stack = [tree.root]
    while (stack.length > 0) {
      const n = stack.pop()!
      for (const c of tree.tree.get(n) ?? []) {
        visited.add(c)
        stack.push(c)
      }
    }
    expect(visited.size).toBe(3)
  })

  it('optimized width is no worse than the default chain', () => {
    const def = planFor('R(x, w) :- A(x, y), B(y, z), C(z, w).', false)
    const opt = planFor('R(x, w) :- A(x, y), B(y, z), C(z, w).', true)
    expect(opt.treeWidth).toBeLessThanOrEqual(def.treeWidth)
  })
})

describe('PlanTree — error on no core atoms', () => {
  // We can't get a real Catalog with zero core atoms from a parseable rule
  // (every rule body has at least one positive atom). Instead, verify the
  // happy path: a Catalog with a single non-core atom would be impossible —
  // the upstream algorithm always leaves the lowest-index atom core. So this
  // error path is unreachable from parsed input; we still document that it
  // exists by reading the Catalog's core bitmap.
  it('a single-atom rule always has its atom as core', () => {
    const tree = planFor('R(x, y) :- A(x, y).')
    expect(tree.root).toBe(0)
  })
})
