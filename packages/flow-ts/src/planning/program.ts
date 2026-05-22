// Port of flowlog/src/planning/src/program.rs

import { Catalog } from '../catalog/index.js'
import type { Strata } from '../strata/index.js'
import { GroupStrataQueryPlan } from './strata.js'
import { RuleQueryPlan } from './rule.js'
import {
  type Transformation,
  binaryInputs,
  isUnary,
  transformationOutput,
  unaryInput,
} from './transformations.js'

/** Top-level execution plan for an entire stratified program. */
export class ProgramQueryPlan {
  constructor(public readonly programPlan: GroupStrataQueryPlan[]) {}

  static fromStrata(
    strata: Strata,
    disableSharing: boolean,
    optLevel: number | null,
  ): ProgramQueryPlan {
    // Build per-rule plans, grouped by stratum, deciding sip / planning per rule.
    type Group = { isRecursive: boolean; plans: RuleQueryPlan[] }
    const groupChain: Group[] = []

    const stratumRules = strata.strata()
    const bitmap = strata.isRecursiveStrataBitmap
    for (let i = 0; i < stratumRules.length; i++) {
      const stratum = stratumRules[i]!
      const isRecursive = bitmap[i]!
      let ruleIdentifier = 0
      let anySip = false

      const chain: RuleQueryPlan[] = []
      for (const rule of stratum) {
        const catalog = Catalog.fromStrata(rule)
        const coreCount = catalog.isCoreAtomBitmap.filter((c) => c).length
        let isSip = false
        let isPlanning = false
        if (coreCount > 2) {
          if (optLevel === null) {
            isSip = rule.isSip
            isPlanning = rule.isPlanning
          } else {
            isSip = optLevel === 1 || optLevel === 3 || rule.isSip
            isPlanning = optLevel >= 2 || rule.isPlanning
          }
        }
        if (isSip) anySip = true

        const expandedCatalogs = isSip ? catalog.sideways(ruleIdentifier) : [catalog]
        ruleIdentifier++

        for (const expanded of expandedCatalogs) {
          chain.push(RuleQueryPlan.fromCatalog(expanded, isPlanning))
        }
      }

      // A non-recursive stratum that uses SIP gets split into one mini-stratum
      // per rule plan (since sideways info passing slices into cascading sub-plans).
      if (!isRecursive && anySip) {
        for (const plan of chain) {
          groupChain.push({ isRecursive: false, plans: [plan] })
        }
      } else {
        groupChain.push({ isRecursive, plans: chain })
      }
    }

    const seenSet = new Set<string>()
    const programPlan: GroupStrataQueryPlan[] = []
    for (const { isRecursive, plans } of groupChain) {
      programPlan.push(GroupStrataQueryPlan.build(isRecursive, plans, seenSet, disableSharing))
    }

    return new ProgramQueryPlan(programPlan)
  }

  /** Largest arity dimension (key or value) seen across the entire plan. */
  maxArity(): number {
    let max = 0
    for (const groupPlan of this.programPlan) {
      for (const transformation of groupPlan.strataPlanFlat()) {
        const arities = aritiesOf(transformation)
        for (const a of arities) if (a > max) max = a
      }
    }
    return max
  }

  /** Maximal (key_arity, value_arity) pairs incomparable under dominance. */
  maximalArityPairs(): Array<[number, number]> {
    const allPairs: Array<[number, number]> = []
    for (const groupPlan of this.programPlan) {
      for (const transformation of groupPlan.strataPlanFlat()) {
        const pairs = arityPairsOf(transformation)
        for (const p of pairs) allPairs.push(p)
      }
    }
    const maximal: Array<[number, number]> = []
    for (const pair of allPairs) {
      if (maximal.some((p) => p[0] === pair[0] && p[1] === pair[1])) continue
      const [k1, v1] = pair
      const dominated = allPairs.some(
        ([k2, v2]) => k2 >= k1 && v2 >= v1 && (k2 > k1 || v2 > v1),
      )
      if (!dominated) maximal.push(pair)
    }
    return maximal
  }

  /** True when any (key, value) arity exceeds the fixed-size fallback. */
  shouldUseFatMode(
    userRequestedFatMode: boolean,
    fallbackKey: number,
    fallbackValue: number,
  ): boolean {
    if (userRequestedFatMode) return true
    return this.maximalArityPairs().some(([k, v]) => k > fallbackKey || v > fallbackValue)
  }
}

function aritiesOf(t: Transformation): number[] {
  const out: number[] = []
  const [ko, vo] = transformationOutput(t).arity()
  out.push(ko, vo)
  if (isUnary(t)) {
    const [k, v] = unaryInput(t).arity()
    out.push(k, v)
  } else {
    const [left, right] = binaryInputs(t)
    const [lk, lv] = left.arity()
    const [rk, rv] = right.arity()
    out.push(lk, lv, rk, rv)
  }
  return out
}

function arityPairsOf(t: Transformation): Array<[number, number]> {
  const out: Array<[number, number]> = [transformationOutput(t).arity()]
  if (isUnary(t)) {
    out.push(unaryInput(t).arity())
  } else {
    const [left, right] = binaryInputs(t)
    out.push(left.arity(), right.arity())
  }
  return out
}
