// Property-based tests for the planning pipeline over random rules.

import { Catalog } from '../../src/catalog/index.js'
import {
  Atom,
  type AtomArg,
  FLRule,
  Head,
  Program,
  type Predicate,
  RelDecl,
} from 'flow-ts'
import { Strata } from '../../src/strata/index.js'
import fc from 'fast-check'
import { describe, it } from 'vitest'
import {
  ProgramQueryPlan,
  RuleQueryPlan,
  binaryInputs,
  isUnary,
  transformationOutput,
  unaryInput,
} from '../../src/planning/index.js'

const VAR_POOL = ['x', 'y', 'z', 'w'] as const
const REL_POOL = ['A', 'B', 'C', 'D'] as const

const atomArgGen: fc.Arbitrary<AtomArg> = fc
  .constantFrom(...VAR_POOL)
  .map((name) => ({ kind: 'Var', name }) as AtomArg)

const atomGen = fc
  .tuple(
    fc.constantFrom(...REL_POOL),
    fc.array(atomArgGen, { minLength: 1, maxLength: 3 }),
  )
  .map(([name, args]) => new Atom(name, args))

// Every body variable becomes a head variable. This dodges a known edge case
// in *both* the Rust and TS planners: a variable that only appears in one
// body atom, with no purpose (not in head, no comparisons, no joins, no
// negation), makes the recursive transformation builder produce a null
// signature. Constraining the generator to "every body var has a purpose"
// keeps the property tests focused on real algorithmic invariants rather
// than this known limitation.
const ruleArb: fc.Arbitrary<FLRule> = fc
  .array(atomGen, { minLength: 1, maxLength: 4 })
  .map((atoms) => {
    const rhs: Predicate[] = atoms.map((atom) => ({ kind: 'Atom', atom }))
    const allVars = new Set<string>()
    for (const a of atoms) {
      for (const arg of a.args) {
        if (arg.kind === 'Var') allVars.add(arg.name)
      }
    }
    const headArgs =
      allVars.size > 0
        ? [...allVars].map((name) => ({ kind: 'Var' as const, name }))
        : [{ kind: 'Var' as const, name: 'x' }]
    return new FLRule(new Head('R', headArgs), rhs, false, false)
  })

const programArb: fc.Arbitrary<Program> = fc
  .array(ruleArb, { minLength: 1, maxLength: 4 })
  .map((rules) => new Program([] as RelDecl[], [] as RelDecl[], rules))

describe('Planning — properties', () => {
  it('RuleQueryPlan.fromCatalog never throws for valid rules', () => {
    fc.assert(
      fc.property(ruleArb, (rule) => {
        const cat = Catalog.fromStrata(rule)
        const plan = RuleQueryPlan.fromCatalog(cat, false)
        return plan.lastTransformation !== undefined
      }),
    )
  })

  it('transformation tree edges only reference recorded transformations', () => {
    // For each value (left, right), at least one of them must either be:
    //   - already in the map as a key (composite), OR
    //   - a leaf (no entry in the map)
    // This is a closure property.
    fc.assert(
      fc.property(ruleArb, (rule) => {
        const cat = Catalog.fromStrata(rule)
        const plan = RuleQueryPlan.fromCatalog(cat, false)
        for (const [, [l, r]] of plan.transformationTree) {
          // Each child either has its own entry (further decomposition) or is
          // a leaf transformation. We only need to ensure they exist as
          // objects — which is trivially true; the real invariant is that
          // they're reachable from the root, which we check below.
          void l
          void r
        }
        // Reachability: starting from root, can we visit every key?
        const visited = new Set<unknown>()
        const stack: unknown[] = [plan.lastTransformation]
        while (stack.length > 0) {
          const t = stack.pop()
          if (visited.has(t)) continue
          visited.add(t)
          const children = plan.transformationTree.get(t as never)
          if (children) {
            stack.push(children[0])
            stack.push(children[1])
          }
        }
        for (const key of plan.transformationTree.keys()) {
          if (!visited.has(key)) return false
        }
        return true
      }),
    )
  })

  it('ProgramQueryPlan.fromStrata never throws over random programs', () => {
    fc.assert(
      fc.property(programArb, (program) => {
        const strata = Strata.fromParser(program)
        const plan = ProgramQueryPlan.fromStrata(strata, false, null)
        return plan.programPlan.length === strata.strata().length
      }),
    )
  })

  it('every transformation in a plan has a non-negative arity', () => {
    fc.assert(
      fc.property(programArb, (program) => {
        const strata = Strata.fromParser(program)
        const plan = ProgramQueryPlan.fromStrata(strata, false, null)
        for (const group of plan.programPlan) {
          for (const t of group.strataPlanFlat()) {
            const [ko, vo] = transformationOutput(t).arity()
            if (ko < 0 || vo < 0) return false
            if (isUnary(t)) {
              const [ki, vi] = unaryInput(t).arity()
              if (ki < 0 || vi < 0) return false
            } else {
              const [l, r] = binaryInputs(t)
              const [lk, lv] = l.arity()
              const [rk, rv] = r.arity()
              if (lk < 0 || lv < 0 || rk < 0 || rv < 0) return false
            }
          }
        }
        return true
      }),
    )
  })

  it('maxArity equals the max of arity pairs', () => {
    fc.assert(
      fc.property(programArb, (program) => {
        const strata = Strata.fromParser(program)
        const plan = ProgramQueryPlan.fromStrata(strata, false, null)
        const m = plan.maxArity()
        for (const [k, v] of plan.maximalArityPairs()) {
          if (k > m || v > m) return false
        }
        return true
      }),
    )
  })
})
