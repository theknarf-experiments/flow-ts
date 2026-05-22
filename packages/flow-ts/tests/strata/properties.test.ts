// Property-based tests for stratification using fast-check.
//
// We generate random rule dependency graphs and check four properties that the
// stratification algorithm must satisfy for *every* well-formed input.

import {
  Atom,
  type AtomArg,
  FLRule,
  Head,
  type HeadArg,
  Program,
  type Predicate,
  RelDecl,
} from 'flow-ts'
import fc from 'fast-check'
import { describe, it } from 'vitest'
import { Strata } from '../../src/strata/index.js'

const HEAD_POOL = ['a', 'b', 'c', 'd', 'e'] as const

/** Generator-shape for a single rule. */
type GenRule = {
  head: string
  pos: readonly string[]
  neg: readonly string[]
}

const headName = fc.constantFrom(...HEAD_POOL)

const ruleArb: fc.Arbitrary<GenRule> = fc.record({
  head: headName,
  pos: fc.array(headName, { maxLength: 4 }),
  neg: fc.array(headName, { maxLength: 2 }),
})

const programArb: fc.Arbitrary<GenRule[]> = fc.array(ruleArb, {
  minLength: 1,
  maxLength: 8,
})

function toProgram(genRules: readonly GenRule[]): Program {
  const headArgs: HeadArg[] = [{ kind: 'Var', name: 'X' }]
  const flRules = genRules.map((g) => {
    const head = new Head(g.head, headArgs)
    const rhs: Predicate[] = []
    for (const name of g.pos) {
      rhs.push({
        kind: 'Atom',
        atom: new Atom(name, [{ kind: 'Var', name: 'X' } satisfies AtomArg]),
      })
    }
    for (const name of g.neg) {
      rhs.push({
        kind: 'NegatedAtom',
        atom: new Atom(name, [{ kind: 'Var', name: 'X' }]),
      })
    }
    return new FLRule(head, rhs, false, false)
  })
  return new Program([] as RelDecl[], [] as RelDecl[], flRules)
}

/** Return stratum index for each rule index. */
function stratumIndexByRule(strata: Strata, ruleCount: number): number[] {
  const out = new Array<number>(ruleCount).fill(-1)
  const partition = strata.strataIndices()
  for (let s = 0; s < partition.length; s++) {
    for (const id of partition[s]!) out[id] = s
  }
  return out
}

/** Heads → rule indices for a generated program. */
function headToRuleIds(rules: readonly GenRule[]): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (let i = 0; i < rules.length; i++) {
    const arr = out.get(rules[i]!.head) ?? []
    arr.push(i)
    out.set(rules[i]!.head, arr)
  }
  return out
}

/** Forward-reachability in the rule dependency map starting at `from`. */
function reachable(
  from: number,
  depMap: ReadonlyMap<number, ReadonlySet<number>>,
): Set<number> {
  const visited = new Set<number>([from])
  const stack: number[] = [from]
  while (stack.length) {
    const u = stack.pop()!
    for (const v of depMap.get(u) ?? []) {
      if (!visited.has(v)) {
        visited.add(v)
        stack.push(v)
      }
    }
  }
  return visited
}

describe('Strata — properties', () => {
  it('is deterministic for the same program', () => {
    fc.assert(
      fc.property(programArb, (gen) => {
        const program = toProgram(gen)
        const a = Strata.fromParser(program).strataIndices()
        const b = Strata.fromParser(program).strataIndices()
        const aJson = JSON.stringify(a.map((s) => [...s].sort((x, y) => x - y)))
        const bJson = JSON.stringify(b.map((s) => [...s].sort((x, y) => x - y)))
        return aJson === bJson
      }),
    )
  })

  it('every rule appears in exactly one stratum', () => {
    fc.assert(
      fc.property(programArb, (gen) => {
        const program = toProgram(gen)
        const partition = Strata.fromParser(program).strataIndices()
        const seen = new Set<number>()
        for (const stratum of partition) {
          for (const id of stratum) {
            if (seen.has(id)) return false
            seen.add(id)
          }
        }
        return seen.size === gen.length
      }),
    )
  })

  it('respects topological order for every cross-stratum dependency edge', () => {
    // For any edge i → j in the combined rule_dependency_map (positive OR
    // negation), if i and j land in different strata, j's stratum index must
    // come strictly before i's. Same-stratum edges represent a recursive SCC
    // and are allowed.
    fc.assert(
      fc.property(programArb, (gen) => {
        const program = toProgram(gen)
        const strata = Strata.fromParser(program)
        const stratumOf = stratumIndexByRule(strata, gen.length)
        const head2ids = headToRuleIds(gen)
        for (let i = 0; i < gen.length; i++) {
          const bodyNames = [...gen[i]!.pos, ...gen[i]!.neg]
          for (const name of bodyNames) {
            const targets = head2ids.get(name)
            if (!targets) continue
            for (const j of targets) {
              if (stratumOf[i] !== stratumOf[j] && stratumOf[j]! >= stratumOf[i]!) {
                return false
              }
            }
          }
        }
        return true
      }),
    )
  })

  it('recursive flag matches strongly-connected structure of the stratum', () => {
    // A non-recursive stratum is either (a) a single 1-rule SCC without a
    // self-loop, or (b) a merger-pass batch of independent 1-rule SCCs whose
    // dependencies were all resolved in the same wave. Either way, the rules
    // it contains must be pairwise unreachable in the dependency graph and
    // have no self-loops.
    //
    // A recursive stratum is a single SCC of the dependency graph, so every
    // rule in it must be reachable from every other rule.
    fc.assert(
      fc.property(programArb, (gen) => {
        const program = toProgram(gen)
        const strata = Strata.fromParser(program)
        const partition = strata.strataIndices()
        const bitmap = strata.isRecursiveStrataBitmap
        const depMap = strata.dependencyGraph.ruleDependencyMap

        for (let s = 0; s < partition.length; s++) {
          const stratum = partition[s]!
          if (bitmap[s]) {
            // Recursive: every pair must be mutually reachable.
            for (const i of stratum) {
              const fromI = reachable(i, depMap)
              for (const j of stratum) {
                if (i === j) continue
                if (!fromI.has(j)) return false
              }
            }
            // Size-1 recursive stratum requires a self-loop.
            if (stratum.length === 1) {
              const i = stratum[0]!
              if (!depMap.get(i)?.has(i)) return false
            }
          } else {
            // Non-recursive: no self-loop, and no pair is mutually reachable.
            for (const i of stratum) {
              if (depMap.get(i)?.has(i)) return false
              const fromI = reachable(i, depMap)
              for (const j of stratum) {
                if (i === j) continue
                const fromJ = reachable(j, depMap)
                if (fromI.has(j) && fromJ.has(i)) return false
              }
            }
          }
        }
        return true
      }),
    )
  })

  it('negation edges that span strata place the negated rule strictly earlier', () => {
    // This is a corollary of the topological-order property, but we verify it
    // explicitly against the negation_dependency_map for clarity.
    fc.assert(
      fc.property(programArb, (gen) => {
        const program = toProgram(gen)
        const strata = Strata.fromParser(program)
        const stratumOf = stratumIndexByRule(strata, gen.length)
        const head2ids = headToRuleIds(gen)
        for (let i = 0; i < gen.length; i++) {
          for (const name of gen[i]!.neg) {
            const targets = head2ids.get(name)
            if (!targets) continue
            for (const j of targets) {
              if (stratumOf[i] === stratumOf[j]) continue
              if (stratumOf[j]! >= stratumOf[i]!) return false
            }
          }
        }
        return true
      }),
    )
  })
})
