// Port of flowlog/src/planning/src/strata.rs
//
// A GroupStrataQueryPlan linearizes the per-rule transformation trees of a
// stratum (recursive or non-recursive) into one or more execution lists,
// sharing intermediate signatures where allowed.

import type { FLRule } from '../ast/index.js'
import {
  type CollectionSignature,
  newAtomSignature,
} from './collections.js'
import type { RuleQueryPlan } from './rule.js'
import {
  type Transformation,
  isUnary,
  transformationOutput,
  unaryInput,
} from './transformations.js'

type TransformationTree = Map<Transformation, [Transformation, Transformation]>

/** A linearized execution plan for one stratum. */
export class GroupStrataQueryPlan {
  constructor(
    public readonly isRecursive: boolean,
    public readonly rules: FLRule[],
    /** Base / intermediate signatures that must be in scope (recursive only). */
    public readonly enterScope: Set<string>,
    /** Map of head signature name → its output signature names. */
    public readonly lastSignaturesMap: Map<string, string[]>,
    public readonly reverseLastSignaturesMap: Map<string, string[]>,
    /** strataPlan[i] is the linearized transformations for rules[i]. */
    public readonly strataPlan: Transformation[][],
  ) {}

  static build(
    isRecursive: boolean,
    rulePlans: readonly RuleQueryPlan[],
    seenSet: Set<string>,
    disableSharing: boolean,
  ): GroupStrataQueryPlan {
    const rules = rulePlans.map((rp) => rp.rule)

    const lastSignaturesMap = new Map<string, string[]>()
    for (const rp of rulePlans) {
      const headName = newAtomSignature(rp.rule.head.name).name
      const lastName = transformationOutput(rp.rulePlan()[0]).signature.name
      const entry = lastSignaturesMap.get(headName) ?? []
      entry.push(lastName)
      lastSignaturesMap.set(headName, entry)
    }

    const reverseLastSignaturesMap = new Map<string, string[]>()
    for (const [headName, lasts] of lastSignaturesMap) {
      for (const last of lasts) {
        const entry = reverseLastSignaturesMap.get(last) ?? []
        entry.push(headName)
        reverseLastSignaturesMap.set(last, entry)
      }
    }

    const strataPlan: Transformation[][] = []
    const enterScope = new Set<string>()
    const nestedSeen = new Set<string>()

    for (const rulePlan of rulePlans) {
      const [root, tree] = rulePlan.rulePlan()
      if (!isRecursive) {
        strataPlan.push(constructNonRecursive(seenSet, root, tree, disableSharing))
      } else {
        const [plan, ruleEnterScope] = constructRecursive(
          seenSet,
          nestedSeen,
          root,
          tree,
          disableSharing,
        )
        strataPlan.push(plan)
        for (const sig of ruleEnterScope) enterScope.add(sig)
      }
    }

    return new GroupStrataQueryPlan(
      isRecursive,
      rules,
      enterScope,
      lastSignaturesMap,
      reverseLastSignaturesMap,
      strataPlan,
    )
  }

  /** Flatten the per-rule transformation lists. */
  strataPlanFlat(): Transformation[] {
    const out: Transformation[] = []
    for (const xs of this.strataPlan) out.push(...xs)
    return out
  }

  /** Head signatures of the stratum, excluding intermediate SIP-generated ones. */
  headSignaturesSet(): Set<string> {
    const out = new Set<string>()
    for (const sigName of this.lastSignaturesMap.keys()) {
      if (!sigName.includes('_sip')) out.add(sigName)
    }
    return out
  }

  /** Map of head relation name → arity. */
  heads(): Map<string, number> {
    const out = new Map<string, number>()
    for (const rule of this.rules) out.set(rule.head.name, rule.head.arity())
    return out
  }
}

function constructNonRecursive(
  seen: Set<string>,
  root: Transformation,
  tree: TransformationTree,
  disableSharing: boolean,
): Transformation[] {
  const sigName = transformationOutput(root).signature.name
  if (!disableSharing && seen.has(sigName)) return []
  if (!disableSharing) seen.add(sigName)

  const downstream = tree.get(root)
  if (!downstream) return [root]
  const [lRoot, rRoot] = downstream
  const plan: Transformation[] = []
  plan.push(...constructNonRecursive(seen, lRoot, tree, disableSharing))
  plan.push(...constructNonRecursive(seen, rRoot, tree, disableSharing))
  plan.push(root)
  return plan
}

function constructRecursive(
  seen: Set<string>,
  nestedSeen: Set<string>,
  root: Transformation,
  tree: TransformationTree,
  disableSharing: boolean,
): [Transformation[], Set<string>] {
  const sigName = transformationOutput(root).signature.name

  if (!disableSharing && seen.has(sigName)) {
    return [[], new Set<string>([sigName])]
  }
  if (!disableSharing && nestedSeen.has(sigName)) {
    return [[], new Set<string>()]
  }
  if (!disableSharing) nestedSeen.add(sigName)

  const downstream = tree.get(root)
  if (!downstream) {
    // Leaf op: bring its base atom into scope.
    if (!isUnary(root)) {
      throw new Error('constructRecursive: leaf op must be unary')
    }
    const baseName = unaryInput(root).signature.name
    return [[root], new Set<string>([baseName])]
  }
  const [lRoot, rRoot] = downstream
  const [lPlan, lScope] = constructRecursive(seen, nestedSeen, lRoot, tree, disableSharing)
  const [rPlan, rScope] = constructRecursive(seen, nestedSeen, rRoot, tree, disableSharing)
  const plan: Transformation[] = [...lPlan, ...rPlan, root]
  const scope = new Set<string>([...lScope, ...rScope])
  return [plan, scope]
}

// The signature itself isn't directly needed by callers — we re-export for
// completeness, in case downstream wants to wrap the name back into a typed value.
export type { CollectionSignature }
