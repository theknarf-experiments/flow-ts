// Property-based tests for PlanTree invariants over random valid rules.

import { Catalog } from '../../src/catalog/index.js'
import {
  Atom,
  type AtomArg,
  FLRule,
  Head,
  type Predicate,
} from '@flow-ts/parsing'
import fc from 'fast-check'
import { describe, it } from 'vitest'
import { PlanTree } from '../../src/optimizing/index.js'

const VAR_POOL = ['x', 'y', 'z', 'w'] as const
const REL_POOL = ['A', 'B', 'C', 'D'] as const

const atomArgGen: fc.Arbitrary<AtomArg> = fc
  .constantFrom(...VAR_POOL)
  .map((name) => ({ kind: 'Var', name }) as AtomArg)

const atomGen: fc.Arbitrary<Atom> = fc
  .tuple(
    fc.constantFrom(...REL_POOL),
    fc.array(atomArgGen, { minLength: 1, maxLength: 3 }),
  )
  .map(([name, args]) => new Atom(name, args))

// Generate positive-only rules. Use the canonical body order to avoid
// degenerate cases the upstream's `populate_is_core_atom_bitmap` would
// collapse away — but keep them in: it's a real (handled) input shape.
const ruleArb: fc.Arbitrary<FLRule> = fc
  .array(atomGen, { minLength: 1, maxLength: 5 })
  .map((atoms) => {
    const rhs: Predicate[] = atoms.map((atom) => ({ kind: 'Atom', atom }))
    let headVar = 'x'
    outer: for (const a of atoms) {
      for (const arg of a.args) {
        if (arg.kind === 'Var') {
          headVar = arg.name
          break outer
        }
      }
    }
    const head = new Head('R', [{ kind: 'Var', name: headVar }])
    return new FLRule(head, rhs, false, false)
  })

function coreIndices(cat: Catalog): number[] {
  const out: number[] = []
  for (let i = 0; i < cat.isCoreAtomBitmap.length; i++) {
    if (cat.isCoreAtomBitmap[i]) out.push(i)
  }
  return out
}

function reachable(tree: PlanTree): Set<number> {
  const out = new Set<number>([tree.root])
  const stack = [tree.root]
  while (stack.length > 0) {
    const n = stack.pop()!
    for (const c of tree.tree.get(n) ?? []) {
      if (!out.has(c)) {
        out.add(c)
        stack.push(c)
      }
    }
  }
  return out
}

describe('PlanTree — properties', () => {
  it('spans exactly the core atoms (both default and optimized)', () => {
    fc.assert(
      fc.property(ruleArb, fc.boolean(), (rule, optimized) => {
        const cat = Catalog.fromStrata(rule)
        const tree = PlanTree.fromCatalog(cat, optimized)
        const reach = reachable(tree)
        const cores = new Set(coreIndices(cat))
        if (reach.size !== cores.size) return false
        for (const c of cores) if (!reach.has(c)) return false
        return true
      }),
    )
  })

  it('root is a core atom', () => {
    fc.assert(
      fc.property(ruleArb, fc.boolean(), (rule, optimized) => {
        const cat = Catalog.fromStrata(rule)
        const tree = PlanTree.fromCatalog(cat, optimized)
        return cat.isCoreAtomBitmap[tree.root] === true
      }),
    )
  })

  it('subTrees entries are pre-order traversals', () => {
    fc.assert(
      fc.property(ruleArb, fc.boolean(), (rule, optimized) => {
        const cat = Catalog.fromStrata(rule)
        const tree = PlanTree.fromCatalog(cat, optimized)
        for (const [subroot, ordered] of tree.subTrees) {
          if (ordered[0] !== subroot) return false
          // Walk the tree from subroot in pre-order; result must equal ordered.
          const seen: number[] = []
          const recur = (n: number): void => {
            seen.push(n)
            for (const c of tree.tree.get(n) ?? []) recur(c)
          }
          recur(subroot)
          if (seen.length !== ordered.length) return false
          for (let i = 0; i < seen.length; i++) {
            if (seen[i] !== ordered[i]) return false
          }
        }
        return true
      }),
    )
  })

  it('optimized treeWidth is never worse than the default', () => {
    fc.assert(
      fc.property(ruleArb, (rule) => {
        const cat = Catalog.fromStrata(rule)
        const def = PlanTree.fromCatalog(cat, false)
        const opt = PlanTree.fromCatalog(cat, true)
        return opt.treeWidth <= def.treeWidth
      }),
    )
  })

  it('overlap never exceeds maxOverlap', () => {
    fc.assert(
      fc.property(ruleArb, fc.boolean(), (rule, optimized) => {
        const cat = Catalog.fromStrata(rule)
        const tree = PlanTree.fromCatalog(cat, optimized)
        return tree.overlap <= tree.maxOverlap
      }),
    )
  })

  it('every parent appears as a key in tree (children are recorded)', () => {
    fc.assert(
      fc.property(ruleArb, fc.boolean(), (rule, optimized) => {
        const cat = Catalog.fromStrata(rule)
        const tree = PlanTree.fromCatalog(cat, optimized)
        for (const [, children] of tree.tree) {
          for (const c of children) {
            if (!tree.tree.has(c)) return false
          }
        }
        return true
      }),
    )
  })
})
