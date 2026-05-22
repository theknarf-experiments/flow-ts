// Port of flowlog/src/planning/src/rule.rs
//
// RuleQueryPlan converts a Catalog + join PlanTree into a tree of
// Transformations rooted at `lastTransformation`, with each transformation
// mapping to its (left, right) child transformations.

import {
  AtomArgumentSignature,
  AtomSignature,
  type Catalog,
  ComparisonExprPos,
} from '../catalog/index.js'
import type { ComparisonExpr } from '@flow-ts/parsing'
import { PlanTree } from '../optimizing/index.js'
import type { Arithmetic, FLRule, Factor } from '@flow-ts/parsing'
import { Collection, newAtomSignature } from './collections.js'
import { ArithmeticArgument, type FactorArgument } from './arithmetic.js'
import {
  type TransformationFlow,
  type HeadProjection,
} from './flow.js'
import {
  type Transformation,
  buildAntijoin,
  buildJoin,
  buildKvToKv,
  transformationOutput,
} from './transformations.js'

type TransformationTree = Map<Transformation, [Transformation, Transformation]>

export class RuleQueryPlan {
  private constructor(
    public readonly rule: FLRule,
    public readonly dependentAtomNames: Set<string>,
    public readonly plan: PlanTree,
    public readonly lastTransformation: Transformation,
    public readonly transformationTree: TransformationTree,
  ) {}

  /** Returns the root transformation and the (root → (left, right)) tree map. */
  rulePlan(): [Transformation, TransformationTree] {
    return [this.lastTransformation, this.transformationTree]
  }

  static fromCatalog(catalog: Catalog, isOptimized: boolean): RuleQueryPlan {
    const plan = PlanTree.fromCatalog(catalog, isOptimized)
    const isActiveNegationBitmap = catalog.negatedAtomNames.map(() => true)
    const isActiveNonCoreAtomBitmap = catalog.isCoreAtomBitmap.map((c) => !c)
    const activeComparisonPredicates: number[] = []
    for (let i = 0; i < catalog.comparisonPredicates.length; i++) {
      activeComparisonPredicates.push(i)
    }

    const headValueArguments: string[] = []
    for (const headArg of catalog.headArguments()) {
      switch (headArg.kind) {
        case 'Var':
          headValueArguments.push(headArg.name)
          break
        case 'Arith':
          for (const v of headArg.arithmetic.vars()) headValueArguments.push(v)
          break
        case 'Aggregation':
          for (const v of headArg.aggregation.vars()) headValueArguments.push(v)
          break
      }
    }

    let [lastTransformation, transformationTree] = recursiveTransformations(
      catalog,
      plan.subTrees,
      plan.root,
      plan.tree,
      [],
      headValueArguments,
      isActiveNegationBitmap,
      isActiveNonCoreAtomBitmap,
      activeComparisonPredicates,
    )

    if (isActiveNegationBitmap.some((x) => x)) {
      throw new Error('Some negated atoms remain active after plan construction')
    }
    if (isActiveNonCoreAtomBitmap.some((x) => x)) {
      throw new Error('Some non-core atoms remain active after plan construction')
    }

    // Apply a post-map for head arithmetic, if any.
    const headArgs = catalog.headArguments()
    const hasHeadArith = headArgs.some((arg) => arg.kind === 'Arith')
    if (hasHeadArith) {
      const varIndexMap = new Map<string, number>()
      for (let i = 0; i < headValueArguments.length; i++) {
        if (!varIndexMap.has(headValueArguments[i]!)) {
          varIndexMap.set(headValueArguments[i]!, i)
        }
      }

      const projections: HeadProjection[] = headArgs.map((arg) => {
        switch (arg.kind) {
          case 'Var': {
            const idx = varIndexMap.get(arg.name)
            if (idx === undefined) {
              throw new Error(`head var ${arg.name} must be in intermediate`)
            }
            return { kind: 'Copy', index: idx }
          }
          case 'Arith':
            return { kind: 'Compute', arithmetic: buildHeadArithArg(arg.arithmetic, varIndexMap) }
          case 'Aggregation': {
            const v = arg.aggregation.vars()[0]
            if (!v) throw new Error('agg with no vars')
            const idx = varIndexMap.get(v)
            if (idx === undefined) throw new Error(`agg var ${v} must be in intermediate`)
            return { kind: 'Copy', index: idx }
          }
        }
      })

      const flow: TransformationFlow = { kind: 'HeadArith', projections }
      const sentinelAtom = new AtomSignature(true, Number.MAX_SAFE_INTEGER)
      const valueSigs: AtomArgumentSignature[] = headArgs.map(
        (_, i) => new AtomArgumentSignature(sentinelAtom, i),
      )

      const postMapOutput = new Collection(
        {
          kind: 'UnaryTransformationOutput',
          name: `HeadArith(${transformationOutput(lastTransformation).signature.name})`,
        },
        [],
        valueSigs,
      )
      const postMap: Transformation = {
        kind: 'RowToRow',
        input: transformationOutput(lastTransformation),
        output: postMapOutput,
        flow,
        isNoOp: false,
      }
      transformationTree.set(postMap, [lastTransformation, lastTransformation])
      lastTransformation = postMap
    }

    return new RuleQueryPlan(
      catalog.rule,
      catalog.dependentAtomNames(),
      plan,
      lastTransformation,
      transformationTree,
    )
  }
}

function buildHeadArithArg(
  arith: Arithmetic,
  varIndexMap: Map<string, number>,
): ArithmeticArgument {
  const convertFactor = (factor: Factor): FactorArgument => {
    if (factor.kind === 'Var') {
      const idx = varIndexMap.get(factor.name)
      if (idx === undefined) throw new Error(`arith var ${factor.name} must be in intermediate`)
      return { kind: 'Var', argument: { kind: 'KV', isValue: true, id: idx } }
    }
    return { kind: 'Const', value: factor.value }
  }
  const init = convertFactor(arith.init)
  const rest: Array<readonly [import('@flow-ts/parsing').ArithmeticOperator, FactorArgument]> = []
  for (const [op, factor] of arith.rest) {
    rest.push([op, convertFactor(factor)] as const)
  }
  return new ArithmeticArgument(init, rest, arith.dataType)
}

// -------------------------------
// recursive helpers
// -------------------------------

function recursiveTransformations(
  catalog: Catalog,
  subTrees: Map<number, number[]>,
  root: number,
  tree: Map<number, number[]>,
  headKeyArguments: readonly string[],
  headValueArguments: readonly string[],
  isActiveNegationBitmap: boolean[],
  isActiveNonCoreAtomBitmap: boolean[],
  activeComparisonPredicates: readonly number[],
): [Transformation, TransformationTree] {
  const planningAtomSignature = new AtomSignature(true, root)
  const children = tree.get(root) ?? []

  if (children.length === 0) {
    return perAtomRecursiveSemijoinsAndAntijoins(
      catalog,
      planningAtomSignature,
      headKeyArguments,
      headValueArguments,
      isActiveNegationBitmap,
      isActiveNonCoreAtomBitmap,
      activeComparisonPredicates,
    )
  }

  const planningChild = children[children.length - 1]!
  const planningSubtree = subTrees.get(planningChild)!

  const leftoverSubtrees: number[] = [root]
  for (let i = 0; i < children.length - 1; i++) {
    const sub = subTrees.get(children[i]!)
    if (sub) leftoverSubtrees.push(...sub)
  }

  const headArgumentsSet = new Set<string>([...headKeyArguments, ...headValueArguments])

  const leftoverVarsSet = catalog.varsSet(leftoverSubtrees)
  const planningVarsSet = catalog.varsSet(planningSubtree)

  const {
    join: joinCompIds,
    left: leftCompIds,
    right: rightCompIds,
  } = catalog.partitionComparisonPredicates(
    leftoverVarsSet,
    planningVarsSet,
    activeComparisonPredicates,
  )

  const negatedAtomSignatures = catalog.attachNegatedAtomsOnJoins(
    leftoverVarsSet,
    planningVarsSet,
    isActiveNegationBitmap,
  )
  const negatedVars = catalog.negatedVars(negatedAtomSignatures.map((s) => s.rhsId))
  const negatedVarsSet = new Set<string>(negatedVars)

  const joinActiveVars = catalog.comparisonPredicatesVarsSetFor(joinCompIds)
  const joinActiveVarsSet = new Set<string>(joinActiveVars)

  const joinKeyStrs: string[] = []
  const planningValueStrs: string[] = []
  const joinKeyStrsSet = new Set<string>()
  const planningVarsSeenSet = new Set<string>()

  for (const planningRhsId of planningSubtree) {
    for (const planningArgSig of catalog.atomArgumentSignatures[planningRhsId]!) {
      if (catalog.isConstOrVarEqOrPlaceholder(planningArgSig)) continue
      const planningArgStr = catalog.signatureToArgumentStrMap.get(planningArgSig)!
      if (planningVarsSeenSet.has(planningArgStr)) continue
      planningVarsSeenSet.add(planningArgStr)

      if (leftoverVarsSet.has(planningArgStr)) {
        joinKeyStrs.push(planningArgStr)
        joinKeyStrsSet.add(planningArgStr)
      } else if (
        headArgumentsSet.has(planningArgStr) ||
        joinActiveVarsSet.has(planningArgStr) ||
        negatedVarsSet.has(planningArgStr)
      ) {
        planningValueStrs.push(planningArgStr)
      }
    }
  }

  const leftoverValueStrs: string[] = []
  const leftoverVarsSeenSet = new Set<string>()
  for (const leftoverRhsId of leftoverSubtrees) {
    for (const leftoverArgSig of catalog.atomArgumentSignatures[leftoverRhsId]!) {
      if (catalog.isConstOrVarEqOrPlaceholder(leftoverArgSig)) continue
      const leftoverArgStr = catalog.signatureToArgumentStrMap.get(leftoverArgSig)!
      if (leftoverVarsSeenSet.has(leftoverArgStr)) continue
      leftoverVarsSeenSet.add(leftoverArgStr)

      if (planningVarsSet.has(leftoverArgStr)) {
        if (!joinKeyStrsSet.has(leftoverArgStr)) {
          throw new Error('join key arguments not consistent')
        }
      } else if (
        headArgumentsSet.has(leftoverArgStr) ||
        joinActiveVarsSet.has(leftoverArgStr) ||
        negatedVarsSet.has(leftoverArgStr)
      ) {
        leftoverValueStrs.push(leftoverArgStr)
      }
    }
  }

  // Drop the planning child from the parent's children list for the recursive call.
  const truncatedTree = new Map<number, number[]>()
  for (const [k, v] of tree) truncatedTree.set(k, [...v])
  truncatedTree.get(root)!.pop()

  const [rightTransformation, rightTree] = recursiveTransformations(
    catalog,
    subTrees,
    planningChild,
    truncatedTree,
    joinKeyStrs,
    planningValueStrs,
    isActiveNegationBitmap,
    isActiveNonCoreAtomBitmap,
    rightCompIds,
  )

  const [leftTransformation, leftTree] = recursiveTransformations(
    catalog,
    subTrees,
    root,
    truncatedTree,
    joinKeyStrs,
    leftoverValueStrs,
    isActiveNegationBitmap,
    isActiveNonCoreAtomBitmap,
    leftCompIds,
  )

  // ----- final join (followed by zero or more antijoins) -----
  const subtreeAtomSignatures = (subTrees.get(root) ?? []).map(
    (rhsId) => new AtomSignature(true, rhsId),
  )

  const subtreeUnionVars = new Set<string>([...leftoverVarsSet, ...planningVarsSet])
  const compareExprSignatures = assembleComparisons(
    catalog,
    joinCompIds,
    subtreeAtomSignatures,
    subtreeUnionVars,
  )

  let lastJoin: Transformation
  const topTree: TransformationTree = new Map()

  if (negatedAtomSignatures.length === 0) {
    lastJoin = buildJoin(
      transformationOutput(leftTransformation),
      transformationOutput(rightTransformation),
      catalog.topDownTrace(headKeyArguments, subtreeAtomSignatures),
      catalog.topDownTrace(headValueArguments, subtreeAtomSignatures),
      compareExprSignatures,
    )
    topTree.set(lastJoin, [leftTransformation, rightTransformation])
  } else {
    const firstNeg = negatedAtomSignatures[0]!
    const firstNegRhsId = firstNeg.rhsId
    const firstNegArgSigs = catalog.negatedAtomArgumentSignatures[firstNegRhsId]!
    const firstNegVarSigs = firstNegArgSigs.filter(
      (sig) => !catalog.isConstOrVarEqOrPlaceholder(sig),
    )
    const firstAntijoinKeyArgs = catalog.signatureToArgumentStrs(firstNegVarSigs)
    const firstAntijoinKeyArgsSet = new Set<string>(firstAntijoinKeyArgs)

    const seenSet = new Set<string>()
    const firstAntijoinValueArgs: string[] = []
    for (const argStr of [...joinKeyStrs, ...leftoverValueStrs, ...planningValueStrs]) {
      if (firstAntijoinKeyArgsSet.has(argStr)) continue
      if (seenSet.has(argStr)) continue
      seenSet.add(argStr)
      firstAntijoinValueArgs.push(argStr)
    }

    const baseJoin = buildJoin(
      transformationOutput(leftTransformation),
      transformationOutput(rightTransformation),
      catalog.topDownTrace(firstAntijoinKeyArgs, subtreeAtomSignatures),
      catalog.topDownTrace(firstAntijoinValueArgs, subtreeAtomSignatures),
      compareExprSignatures,
    )

    const [lastAntijoin, antijoinTree] = recursiveAntijoins(
      catalog,
      subtreeAtomSignatures,
      baseJoin,
      negatedAtomSignatures,
      headKeyArguments,
      headValueArguments,
      activeComparisonPredicates,
    )
    antijoinTree.set(baseJoin, [leftTransformation, rightTransformation])

    lastJoin = lastAntijoin
    for (const [k, v] of antijoinTree) topTree.set(k, v)
  }

  for (const [k, v] of leftTree) topTree.set(k, v)
  for (const [k, v] of rightTree) topTree.set(k, v)

  return [lastJoin, topTree]
}

function perAtomRecursiveSemijoinsAndAntijoins(
  catalog: Catalog,
  planningAtomSignature: AtomSignature,
  headKeyArguments: readonly string[],
  headValueArguments: readonly string[],
  isActiveNegationBitmap: boolean[],
  isActiveNonCoreAtomBitmap: boolean[],
  activeComparisonPredicates: readonly number[],
): [Transformation, TransformationTree] {
  const planningRhsId = planningAtomSignature.rhsId
  const planningArgSigs = catalog.atomArgumentSignatures[planningRhsId]!
  const planningVarSigs = planningArgSigs.filter(
    (sig) => !catalog.isConstOrVarEqOrPlaceholder(sig),
  )

  const subatomSigs: AtomSignature[] = []
  for (const subatomSig of catalog.subAtoms(planningVarSigs)) {
    const id = subatomSig.rhsId
    if (isActiveNonCoreAtomBitmap[id]) {
      isActiveNonCoreAtomBitmap[id] = false
      subatomSigs.push(subatomSig)
    }
  }

  const negatedAtomSigs: AtomSignature[] = []
  for (const negSig of catalog.subNegatedAtoms(planningVarSigs)) {
    const id = negSig.rhsId
    if (isActiveNegationBitmap[id]) {
      isActiveNegationBitmap[id] = false
      negatedAtomSigs.push(negSig)
    }
  }

  if (negatedAtomSigs.length === 0) {
    return recursiveSemijoins(
      catalog,
      planningAtomSignature,
      subatomSigs,
      headKeyArguments,
      headValueArguments,
      activeComparisonPredicates,
    )
  }

  const firstNeg = negatedAtomSigs[0]!
  const firstNegRhsId = firstNeg.rhsId
  const firstNegArgSigs = catalog.negatedAtomArgumentSignatures[firstNegRhsId]!
  const firstNegVarSigs = firstNegArgSigs.filter(
    (sig) => !catalog.isConstOrVarEqOrPlaceholder(sig),
  )
  const subsequentAntijoinKeyArgs = catalog.signatureToArgumentStrs(firstNegVarSigs)
  const subsequentAntijoinKeySet = new Set<string>(subsequentAntijoinKeyArgs)

  const negatedVarsSet = catalog.negatedVarsSet(negatedAtomSigs.map((s) => s.rhsId))

  const planningArgsStr = catalog.signatureToArgumentStrs(planningVarSigs)
  const headSet = new Set<string>([...headKeyArguments, ...headValueArguments])
  const valueArgs: string[] = []
  for (const argStr of planningArgsStr) {
    if (subsequentAntijoinKeySet.has(argStr)) continue
    if (!headSet.has(argStr) && !negatedVarsSet.has(argStr)) continue
    valueArgs.push(argStr)
  }

  const [leftTransformation, bottomTree] = recursiveSemijoins(
    catalog,
    planningAtomSignature,
    subatomSigs,
    subsequentAntijoinKeyArgs,
    valueArgs,
    activeComparisonPredicates,
  )

  const [rootTransformation, topTree] = recursiveAntijoins(
    catalog,
    [planningAtomSignature],
    leftTransformation,
    negatedAtomSigs,
    headKeyArguments,
    headValueArguments,
    activeComparisonPredicates,
  )

  for (const [k, v] of bottomTree) topTree.set(k, v)
  return [rootTransformation, topTree]
}

function recursiveAntijoins(
  catalog: Catalog,
  planningAtomSignatures: readonly AtomSignature[],
  lastTransformation: Transformation,
  negatedAtomSignatures: readonly AtomSignature[],
  headKeyArguments: readonly string[],
  headValueArguments: readonly string[],
  activeComparisonPredicates: readonly number[],
): [Transformation, TransformationTree] {
  if (negatedAtomSignatures.length === 0) {
    return [lastTransformation, new Map()]
  }
  const negatedAtomSig = negatedAtomSignatures[negatedAtomSignatures.length - 1]!
  const negatedRhsId = negatedAtomSig.rhsId
  const negatedArgSigs = catalog.negatedAtomArgumentSignatures[negatedRhsId]!

  const negatedBaseCollection = new Collection(
    newAtomSignature(catalog.negatedAtomNames[negatedRhsId]!),
    [],
    negatedArgSigs,
  )

  const negatedVarSigs = negatedArgSigs.filter(
    (sig) => !catalog.isConstOrVarEqOrPlaceholder(sig),
  )
  const negatedHeadKeyArgs = catalog.signatureToArgumentStrs(negatedVarSigs)
  const negatedHeadKeySet = new Set<string>(negatedHeadKeyArgs)
  const negatedHeadValueArgs: string[] = []
  const seenSet = new Set<string>()
  for (const argStr of [...headKeyArguments, ...headValueArguments]) {
    if (negatedHeadKeySet.has(argStr)) continue
    if (seenSet.has(argStr)) continue
    seenSet.add(argStr)
    negatedHeadValueArgs.push(argStr)
  }

  const compareExprSignatures = assembleComparisons(
    catalog,
    activeComparisonPredicates,
    [negatedAtomSig],
    negatedHeadKeySet,
  )

  const [leftTransformation, tree] = recursiveAntijoins(
    catalog,
    planningAtomSignatures,
    lastTransformation,
    negatedAtomSignatures.slice(0, negatedAtomSignatures.length - 1),
    negatedHeadKeyArgs,
    negatedHeadValueArgs,
    activeComparisonPredicates,
  )

  const subplanOutput = transformationOutput(leftTransformation)

  const rightTransformation = buildKvToKv(
    negatedBaseCollection,
    negatedVarSigs,
    [],
    catalog.constSignatures(negatedArgSigs),
    catalog.varEqSignatures(negatedArgSigs),
    compareExprSignatures,
  )

  const rootTransformation = buildAntijoin(
    subplanOutput,
    transformationOutput(rightTransformation),
    catalog.topDownTrace(headKeyArguments, planningAtomSignatures),
    catalog.topDownTrace(headValueArguments, planningAtomSignatures),
  )

  tree.set(rootTransformation, [leftTransformation, rightTransformation])
  return [rootTransformation, tree]
}

function recursiveSemijoins(
  catalog: Catalog,
  planningAtomSignature: AtomSignature,
  subatomSignatures: readonly AtomSignature[],
  headKeyArguments: readonly string[],
  headValueArguments: readonly string[],
  activeComparisonPredicates: readonly number[],
): [Transformation, TransformationTree] {
  if (subatomSignatures.length === 0) {
    const planningRhsId = planningAtomSignature.rhsId
    const planningArgSigs = catalog.atomArgumentSignatures[planningRhsId]!
    const planningRowCollection = new Collection(
      newAtomSignature(catalog.atomNames[planningRhsId]!),
      [],
      planningArgSigs,
    )
    const planningArgStrsSet = new Set<string>(
      catalog.signatureToArgumentStrs(planningArgSigs),
    )
    const compareExprSignatures = assembleComparisons(
      catalog,
      activeComparisonPredicates,
      [planningAtomSignature],
      planningArgStrsSet,
    )
    if (activeComparisonPredicates.length !== compareExprSignatures.length) {
      throw new Error(
        'active comparisons for semijoins are not fully consumed by the base',
      )
    }
    const leaf = buildKvToKv(
      planningRowCollection,
      catalog.topDownTrace(headKeyArguments, [planningAtomSignature]),
      catalog.topDownTrace(headValueArguments, [planningAtomSignature]),
      catalog.constSignatures(planningArgSigs),
      catalog.varEqSignatures(planningArgSigs),
      compareExprSignatures,
    )
    return [leaf, new Map()]
  }

  const subatomSig = subatomSignatures[subatomSignatures.length - 1]!
  const subatomRhsId = subatomSig.rhsId
  const subatomArgSigs = catalog.atomArgumentSignatures[subatomRhsId]!
  const subatomBaseCollection = new Collection(
    newAtomSignature(catalog.atomNames[subatomRhsId]!),
    [],
    subatomArgSigs,
  )
  const subatomVarSigs = subatomArgSigs.filter(
    (sig) => !catalog.isConstOrVarEqOrPlaceholder(sig),
  )
  const subHeadKeyArgs = catalog.signatureToArgumentStrs(subatomVarSigs)
  const subHeadKeySet = new Set<string>(subHeadKeyArgs)
  const subHeadValueArgs: string[] = []
  const seenSet = new Set<string>()
  for (const argStr of [...headKeyArguments, ...headValueArguments]) {
    if (subHeadKeySet.has(argStr)) continue
    if (seenSet.has(argStr)) continue
    seenSet.add(argStr)
    subHeadValueArgs.push(argStr)
  }
  const compareExprSignatures = assembleComparisons(
    catalog,
    activeComparisonPredicates,
    [subatomSig],
    subHeadKeySet,
  )

  const [leftTransformation, tree] = recursiveSemijoins(
    catalog,
    planningAtomSignature,
    subatomSignatures.slice(0, subatomSignatures.length - 1),
    subHeadKeyArgs,
    subHeadValueArgs,
    activeComparisonPredicates,
  )

  const subplanOutput = transformationOutput(leftTransformation)

  const rightTransformation = buildKvToKv(
    subatomBaseCollection,
    subatomVarSigs,
    [],
    catalog.constSignatures(subatomArgSigs),
    catalog.varEqSignatures(subatomArgSigs),
    compareExprSignatures,
  )

  const rootTransformation = buildJoin(
    subplanOutput,
    transformationOutput(rightTransformation),
    catalog.topDownTrace(headKeyArguments, [planningAtomSignature]),
    catalog.topDownTrace(headValueArguments, [planningAtomSignature]),
    [],
  )

  tree.set(rootTransformation, [leftTransformation, rightTransformation])
  return [rootTransformation, tree]
}

/**
 * Pick comparison predicates whose vars are a subset of the given atoms' vars,
 * and lift them into ComparisonExprPos via top_down_trace (positive variant
 * for all-positive signatures, negated variant for a single negated atom).
 */
function assembleComparisons(
  catalog: Catalog,
  activeComparisonPredicates: readonly number[],
  atomSignatures: readonly AtomSignature[],
  atomVarsSet: ReadonlySet<string>,
): ComparisonExprPos[] {
  const out: ComparisonExprPos[] = []
  for (const compId of activeComparisonPredicates) {
    const compareExpr = catalog.comparisonPredicates[compId]!
    const leftVars = [...compareExpr.leftVars()]
    const rightVars = [...compareExpr.rightVars()]
    let allIn = true
    for (const v of leftVars) if (!atomVarsSet.has(v)) { allIn = false; break }
    if (allIn) for (const v of rightVars) if (!atomVarsSet.has(v)) { allIn = false; break }
    if (!allIn) continue

    if (atomSignatures.every((s) => s.isPositive === true)) {
      out.push(
        // We construct a new ComparisonExprPos that reuses the same arithmetic
        // structure but with trace-resolved signatures. Importing from catalog.
        liftComparisonPos(
          compareExpr,
          catalog.topDownTrace(leftVars, atomSignatures),
          catalog.topDownTrace(rightVars, atomSignatures),
        ),
      )
    } else {
      out.push(
        liftComparisonPos(
          compareExpr,
          catalog.topDownTraceNegated(leftVars, atomSignatures),
          catalog.topDownTraceNegated(rightVars, atomSignatures),
        ),
      )
    }
  }
  return out
}

function liftComparisonPos(
  base: ComparisonExpr,
  leftSigs: readonly AtomArgumentSignature[],
  rightSigs: readonly AtomArgumentSignature[],
): ComparisonExprPos {
  return ComparisonExprPos.fromComparisonExpr(base, leftSigs, rightSigs)
}
