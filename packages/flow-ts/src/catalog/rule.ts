// Port of flowlog/src/catalog/src/rule.rs — the per-rule Catalog.
//
// Holds positional metadata for a rule body: which atoms exist, what
// arguments they cover, which atoms are "core" (not strict subsets of
// another), where each variable first appears, what local filters apply
// (var-equality, constants, placeholders), and the comparison predicates.
//
// Also implements SIP rewriting via `sideways()`.

import {
  Atom,
  type AtomArg,
  type ComparisonExpr,
  type Const,
  FLRule,
  Head,
  type HeadArg,
  type Predicate,
  atomArgAsVar,
  atomArgIsVar,
  headArgToString,
} from '../ast/index.js'
import {
  AtomArgumentSignature,
  AtomSignature,
  SignatureMap,
  SignatureSet,
} from './atoms.js'
import { BaseFilters } from './filters.js'

type PopulateResult = {
  signatureToArgumentStrMap: SignatureMap<string>
  atomNames: string[]
  atomArgumentSignatures: AtomArgumentSignature[][]
  negatedAtomNames: string[]
  negatedAtomArgumentSignatures: AtomArgumentSignature[][]
  baseFilters: BaseFilters
  comparisonPredicates: ComparisonExpr[]
}

export class Catalog {
  private constructor(
    public readonly rule: FLRule,
    public readonly signatureToArgumentStrMap: SignatureMap<string>,
    public readonly argumentPresenceMap: Map<string, (AtomArgumentSignature | null)[]>,
    public readonly atomNames: string[],
    public readonly atomArgumentSignatures: AtomArgumentSignature[][],
    public readonly isCoreAtomBitmap: boolean[],
    public readonly negatedAtomNames: string[],
    public readonly negatedAtomArgumentSignatures: AtomArgumentSignature[][],
    public readonly baseFilters: BaseFilters,
    public readonly comparisonPredicates: ComparisonExpr[],
    public readonly comparisonPredicatesVarsSet: Set<string>[],
    public readonly headArgumentsMap: Map<string, HeadArg>,
  ) {}

  // -----------------------------
  // construction
  // -----------------------------

  static fromStrata(rule: FLRule): Catalog {
    const populated = Catalog.populateArgumentSignatures(rule)
    const argumentPresenceMap = Catalog.populateArgumentPresenceMap(
      populated.signatureToArgumentStrMap,
      populated.atomArgumentSignatures,
      populated.baseFilters,
    )
    const isCoreAtomBitmap = Catalog.populateIsCoreAtomBitmap(
      populated.signatureToArgumentStrMap,
      populated.atomArgumentSignatures,
    )
    const comparisonPredicatesVarsSet = Catalog.populateComparisonPredicatesVarsSet(
      populated.comparisonPredicates,
    )
    const headArgumentsMap = new Map<string, HeadArg>()
    for (const headArg of rule.head.headArguments) {
      headArgumentsMap.set(headArgToString(headArg), headArg)
    }

    return new Catalog(
      rule,
      populated.signatureToArgumentStrMap,
      argumentPresenceMap,
      populated.atomNames,
      populated.atomArgumentSignatures,
      isCoreAtomBitmap,
      populated.negatedAtomNames,
      populated.negatedAtomArgumentSignatures,
      populated.baseFilters,
      populated.comparisonPredicates,
      comparisonPredicatesVarsSet,
      headArgumentsMap,
    )
  }

  private static populateArgumentSignatures(r: FLRule): PopulateResult {
    const isSafeSet = new Set<string>()
    const signatureToArgumentStrMap = new SignatureMap<string>()

    const atomNames: string[] = []
    const atomArgumentSignatures: AtomArgumentSignature[][] = []
    const negatedAtomNames: string[] = []
    const negatedAtomArgumentSignatures: AtomArgumentSignature[][] = []

    const varEqMap = new SignatureMap<AtomArgumentSignature>()
    let localVarFirstOccurrenceMap = new Map<string, AtomArgumentSignature>()
    const constMap = new SignatureMap<Const>()
    const placeholderSet = new SignatureSet()

    // Split the rule body into positives / negations / comparisons.
    const positiveAtoms: Atom[] = []
    const negatedAtoms: Atom[] = []
    const comparisonPredicates: ComparisonExpr[] = []
    for (const p of r.rhs) {
      switch (p.kind) {
        case 'Atom':
          positiveAtoms.push(p.atom)
          break
        case 'NegatedAtom':
          negatedAtoms.push(p.atom)
          break
        case 'Compare':
          comparisonPredicates.push(p.expr)
          break
      }
    }

    // (i) Positive atoms.
    for (let rhsId = 0; rhsId < positiveAtoms.length; rhsId++) {
      const atom = positiveAtoms[rhsId]!
      atomNames.push(atom.name)
      const atomSignatures: AtomArgumentSignature[] = []
      const atomSig = new AtomSignature(true, rhsId)

      for (let argumentId = 0; argumentId < atom.args.length; argumentId++) {
        const argument = atom.args[argumentId]!
        const ruleArgumentSignature = new AtomArgumentSignature(atomSig, argumentId)
        atomSignatures.push(ruleArgumentSignature)

        switch (argument.kind) {
          case 'Var': {
            isSafeSet.add(argument.name)
            signatureToArgumentStrMap.set(ruleArgumentSignature, argument.name)
            const first = localVarFirstOccurrenceMap.get(argument.name)
            if (first) {
              varEqMap.set(ruleArgumentSignature, first)
            } else {
              localVarFirstOccurrenceMap.set(argument.name, ruleArgumentSignature)
            }
            break
          }
          case 'Const':
            constMap.set(ruleArgumentSignature, argument.value)
            break
          case 'Placeholder':
            placeholderSet.add(ruleArgumentSignature)
            break
        }
      }
      atomArgumentSignatures.push(atomSignatures)
      localVarFirstOccurrenceMap = new Map()
    }

    // (ii) Negated atoms.
    for (let negRhsId = 0; negRhsId < negatedAtoms.length; negRhsId++) {
      const atom = negatedAtoms[negRhsId]!
      negatedAtomNames.push(atom.name)
      const negatedSignatures: AtomArgumentSignature[] = []
      const atomSig = new AtomSignature(false, negRhsId)

      for (let argumentId = 0; argumentId < atom.args.length; argumentId++) {
        const argument = atom.args[argumentId]!
        const ruleArgumentSignature = new AtomArgumentSignature(atomSig, argumentId)
        negatedSignatures.push(ruleArgumentSignature)

        switch (argument.kind) {
          case 'Var': {
            if (!isSafeSet.has(argument.name)) {
              throw new Error(
                `unsafe var detected at negation !${atom.toString()} of rule ${r.toString()}`,
              )
            }
            signatureToArgumentStrMap.set(ruleArgumentSignature, argument.name)
            const first = localVarFirstOccurrenceMap.get(argument.name)
            if (first) {
              varEqMap.set(ruleArgumentSignature, first)
            } else {
              localVarFirstOccurrenceMap.set(argument.name, ruleArgumentSignature)
            }
            break
          }
          case 'Const':
            constMap.set(ruleArgumentSignature, argument.value)
            break
          case 'Placeholder':
            placeholderSet.add(ruleArgumentSignature)
            break
        }
      }
      negatedAtomArgumentSignatures.push(negatedSignatures)
      localVarFirstOccurrenceMap = new Map()
    }

    return {
      signatureToArgumentStrMap,
      atomNames,
      atomArgumentSignatures,
      negatedAtomNames,
      negatedAtomArgumentSignatures,
      baseFilters: new BaseFilters(varEqMap, constMap, placeholderSet),
      comparisonPredicates,
    }
  }

  private static populateIsCoreAtomBitmap(
    signatureToArgumentStrMap: SignatureMap<string>,
    atomArgumentSignatures: AtomArgumentSignature[][],
  ): boolean[] {
    const isCoreAtomBitmap: boolean[] = atomArgumentSignatures.map(() => true)

    const coreAtomArgumentStrsSet: Set<string>[] = atomArgumentSignatures.map(
      (sigs) => {
        const s = new Set<string>()
        for (const sig of sigs) {
          const v = signatureToArgumentStrMap.get(sig)
          if (v !== undefined) s.add(v)
        }
        return s
      },
    )

    const isSubset = (a: Set<string>, b: Set<string>): boolean => {
      if (a.size > b.size) return false
      for (const v of a) {
        if (!b.has(v)) return false
      }
      return true
    }

    for (let i = 0; i < coreAtomArgumentStrsSet.length; i++) {
      for (let j = 0; j < coreAtomArgumentStrsSet.length; j++) {
        if (i === j) continue
        const a = coreAtomArgumentStrsSet[i]!
        const b = coreAtomArgumentStrsSet[j]!
        if (isSubset(a, b)) {
          if (a.size < b.size) {
            // Strict subset → i is not core.
            isCoreAtomBitmap[i] = false
          } else {
            // Identical sets → mark the larger index non-core.
            const larger = i > j ? i : j
            isCoreAtomBitmap[larger] = false
          }
        }
      }
    }
    return isCoreAtomBitmap
  }

  private static populateArgumentPresenceMap(
    signatureToArgumentStrMap: SignatureMap<string>,
    atomArgumentSignatures: AtomArgumentSignature[][],
    baseFilters: BaseFilters,
  ): Map<string, (AtomArgumentSignature | null)[]> {
    const out = new Map<string, (AtomArgumentSignature | null)[]>()
    for (let rhsId = 0; rhsId < atomArgumentSignatures.length; rhsId++) {
      for (const sig of atomArgumentSignatures[rhsId]!) {
        if (baseFilters.isConstOrVarEqOrPlaceholder(sig)) continue
        const variable = signatureToArgumentStrMap.get(sig)
        if (variable === undefined) {
          throw new Error(
            `populateArgumentPresenceMap: argument signature ${sig.toString()} absent from the signature map`,
          )
        }
        let entry = out.get(variable)
        if (!entry) {
          entry = new Array<AtomArgumentSignature | null>(atomArgumentSignatures.length).fill(null)
          out.set(variable, entry)
        }
        if (entry[rhsId] === null) entry[rhsId] = sig
      }
    }
    return out
  }

  private static populateComparisonPredicatesVarsSet(
    comparisons: readonly ComparisonExpr[],
  ): Set<string>[] {
    return comparisons.map((c) => c.varsSet())
  }

  // -----------------------------
  // accessors
  // -----------------------------

  headName(): string {
    return this.rule.head.name
  }

  headArguments(): HeadArg[] {
    return this.rule.head.headArguments
  }

  /** Distinct variable names appearing in the head (in order). */
  headArgumentsStrs(): string[] {
    const out: string[] = []
    for (const headArg of this.headArguments()) {
      switch (headArg.kind) {
        case 'Var':
          out.push(headArg.name)
          break
        case 'Arith':
          for (const v of headArg.arithmetic.vars()) out.push(v)
          break
        case 'Aggregation':
          for (const v of headArg.aggregation.vars()) out.push(v)
          break
      }
    }
    return out
  }

  /** Set of atom names referenced (positive or negated) in the body. */
  dependentAtomNames(): Set<string> {
    const out = new Set<string>(this.atomNames)
    for (const n of this.negatedAtomNames) out.add(n)
    return out
  }

  signatureToArgumentStrs(sigs: readonly AtomArgumentSignature[]): string[] {
    const out: string[] = []
    for (const sig of sigs) {
      const v = this.signatureToArgumentStrMap.get(sig)
      if (v !== undefined) out.push(v)
    }
    return out
  }

  /**
   * Positive atoms (non-core only) whose argument set is a subset of the given
   * signatures. Returns positive AtomSignatures.
   */
  subAtoms(signatureArguments: readonly AtomArgumentSignature[]): AtomSignature[] {
    const argStrsSet = new Set(this.signatureToArgumentStrs(signatureArguments))
    const out: AtomSignature[] = []
    for (let i = 0; i < this.isCoreAtomBitmap.length; i++) {
      if (this.isCoreAtomBitmap[i]) continue
      const atomArgsSet = new Set(
        this.signatureToArgumentStrs(this.atomArgumentSignatures[i]!),
      )
      if (Catalog.isStringSubset(atomArgsSet, argStrsSet)) {
        out.push(new AtomSignature(true, i))
      }
    }
    return out
  }

  /** Negated atoms whose argument set is a subset of the given signatures. */
  subNegatedAtoms(
    signatureArguments: readonly AtomArgumentSignature[],
  ): AtomSignature[] {
    const argStrsSet = new Set(this.signatureToArgumentStrs(signatureArguments))
    const out: AtomSignature[] = []
    for (let i = 0; i < this.negatedAtomArgumentSignatures.length; i++) {
      const atomArgsSet = new Set(
        this.signatureToArgumentStrs(this.negatedAtomArgumentSignatures[i]!),
      )
      if (Catalog.isStringSubset(atomArgsSet, argStrsSet)) {
        out.push(new AtomSignature(false, i))
      }
    }
    return out
  }

  argumentPresenceForVar(variable: string): (AtomArgumentSignature | null)[] {
    const v = this.argumentPresenceMap.get(variable)
    if (!v) throw new Error(`no presence entry for var ${variable}`)
    return v
  }

  isConstOrVarEqOrPlaceholder(sig: AtomArgumentSignature): boolean {
    return this.baseFilters.isConstOrVarEqOrPlaceholder(sig)
  }

  constSignatures(
    sigs: readonly AtomArgumentSignature[],
  ): Array<[AtomArgumentSignature, Const]> {
    const out: Array<[AtomArgumentSignature, Const]> = []
    for (const sig of sigs) {
      const c = this.baseFilters.constMap.get(sig)
      if (c !== undefined) out.push([sig, c])
    }
    return out
  }

  varEqSignatures(
    sigs: readonly AtomArgumentSignature[],
  ): Array<[AtomArgumentSignature, AtomArgumentSignature]> {
    const out: Array<[AtomArgumentSignature, AtomArgumentSignature]> = []
    for (const alias of sigs) {
      const target = this.baseFilters.varEqMap.get(alias)
      if (target) out.push([target, alias])
    }
    return out
  }

  /** Variable names referenced by the given (positive) atom indices, excluding base-filtered positions. */
  varsSet(rhsIds: readonly number[]): Set<string> {
    const out = new Set<string>()
    for (const rhsId of rhsIds) {
      for (const sig of this.atomArgumentSignatures[rhsId]!) {
        if (this.isConstOrVarEqOrPlaceholder(sig)) continue
        const v = this.signatureToArgumentStrMap.get(sig)
        if (v !== undefined) out.add(v)
      }
    }
    return out
  }

  negatedVarsSet(negRhsIds: readonly number[]): Set<string> {
    return new Set(this.negatedVars(negRhsIds))
  }

  negatedVars(negRhsIds: readonly number[]): string[] {
    const out: string[] = []
    for (const negRhsId of negRhsIds) {
      for (const sig of this.negatedAtomArgumentSignatures[negRhsId]!) {
        if (this.isConstOrVarEqOrPlaceholder(sig)) continue
        const v = this.signatureToArgumentStrMap.get(sig)
        if (v !== undefined) out.push(v)
      }
    }
    return out
  }

  comparisonPredicatesVarsSetFor(compIds: readonly number[]): string[] {
    const out: string[] = []
    for (const id of compIds) {
      for (const v of this.comparisonPredicatesVarsSet[id]!) out.push(v)
    }
    return out
  }

  /**
   * Split active comparison predicates into (join, left, right). A predicate
   * goes to `left` (resp. `right`) when its vars are a subset of that side's
   * vars; otherwise it crosses the join. Asserts vars are covered by the union.
   */
  partitionComparisonPredicates(
    leftVarsSet: ReadonlySet<string>,
    rightVarsSet: ReadonlySet<string>,
    activeComparisonPredicates: readonly number[],
  ): { join: number[]; left: number[]; right: number[] } {
    const join: number[] = []
    const left: number[] = []
    const right: number[] = []
    const union = new Set<string>([...leftVarsSet, ...rightVarsSet])

    for (const i of activeComparisonPredicates) {
      const varsSet = this.comparisonPredicates[i]!.varsSet()
      if (!Catalog.isStringSubset(varsSet, union)) {
        throw new Error(
          `comp vars ${[...varsSet]} not a subset of the subtree vars ${[...union]}`,
        )
      }
      const inLeft = Catalog.isStringSubset(varsSet, leftVarsSet)
      const inRight = Catalog.isStringSubset(varsSet, rightVarsSet)
      if (inLeft) left.push(i)
      if (inRight) right.push(i)
      if (!inLeft && !inRight) join.push(i)
    }

    return { join, left, right }
  }

  /**
   * Identify negated atoms whose argument set straddles a join (not a subset
   * of either side, but a subset of the union). Marks them inactive in-place
   * and returns their AtomSignatures.
   */
  attachNegatedAtomsOnJoins(
    leftVarsSet: ReadonlySet<string>,
    rightVarsSet: ReadonlySet<string>,
    isActiveNegationBitmap: boolean[],
  ): AtomSignature[] {
    const isolated: AtomSignature[] = []
    const union = new Set<string>([...leftVarsSet, ...rightVarsSet])

    for (let i = 0; i < this.negatedAtomArgumentSignatures.length; i++) {
      if (!isActiveNegationBitmap[i]) continue
      const argStrs = this.signatureToArgumentStrs(this.negatedAtomArgumentSignatures[i]!)
      const argSet = new Set(argStrs)
      const inLeft = Catalog.isStringSubset(argSet, leftVarsSet)
      const inRight = Catalog.isStringSubset(argSet, rightVarsSet)
      const inUnion = Catalog.isStringSubset(argSet, union)
      if (!inLeft && !inRight && inUnion) {
        isolated.push(new AtomSignature(false, i))
        isActiveNegationBitmap[i] = false
      }
    }
    return isolated
  }

  /**
   * For each trace argument string, find its first signature in the given
   * positive atom signatures (in order). Throws if any name is absent.
   */
  topDownTrace(
    traceArgumentStrs: readonly string[],
    atomSignatures: readonly AtomSignature[],
  ): AtomArgumentSignature[] {
    for (const s of atomSignatures) {
      if (!s.isPositive) {
        throw new Error(`negated atom for topDownTrace: ${s.toString()}`)
      }
    }
    const positiveRhsIds = atomSignatures.map((s) => s.rhsId)
    const out: AtomArgumentSignature[] = []
    for (const traceArg of traceArgumentStrs) {
      const presence = this.argumentPresenceMap.get(traceArg)
      let found: AtomArgumentSignature | undefined
      if (presence) {
        for (const rhsId of positiveRhsIds) {
          const v = presence[rhsId]
          if (v) {
            found = v
            break
          }
        }
      }
      if (!found) {
        throw new Error(
          `topDownTrace: argument_str ${traceArg} absent from the presence map for positive atoms ${atomSignatures.map((s) => s.toString()).join(', ')}`,
        )
      }
      out.push(found)
    }
    return out
  }

  /**
   * For each trace argument string, find its position in the given (single)
   * negated atom. Throws if more than one negated atom or any name is absent.
   */
  topDownTraceNegated(
    traceArgumentStrs: readonly string[],
    negatedAtomSignatures: readonly AtomSignature[],
  ): AtomArgumentSignature[] {
    if (negatedAtomSignatures.length !== 1) {
      throw new Error('expected exactly one negated atom signature')
    }
    const negatedAtomSignature = negatedAtomSignatures[0]!
    if (negatedAtomSignature.isPositive) {
      throw new Error(
        `positive atom for topDownTraceNegated: ${negatedAtomSignature.toString()}`,
      )
    }
    const negatedSignatures = this.negatedAtomArgumentSignatures[negatedAtomSignature.rhsId]!
    const out: AtomArgumentSignature[] = []
    for (const traceArg of traceArgumentStrs) {
      let pushed = false
      for (const sig of negatedSignatures) {
        const argStr = this.signatureToArgumentStrMap.get(sig)
        if (argStr === undefined) {
          throw new Error(
            `topDownTraceNegated: argument signature ${sig.toString()} absent from the signature map`,
          )
        }
        if (argStr === traceArg) {
          out.push(sig)
          pushed = true
          break
        }
      }
      // If not found, the Rust version silently skips this trace_arg. Match
      // that behavior — the result vector may be shorter than the input.
      void pushed
    }
    return out
  }

  // -----------------------------
  // SIP (sideways info passing)
  // -----------------------------

  /**
   * Generate sideways-info-passing rewrites for this rule. Returns the
   * forward-direction sideways rules, the backward-direction sideways rules,
   * and the final rewritten rule — each wrapped in its own Catalog. The
   * `ruleLoc` is used to name generated sideway atoms.
   */
  sideways(ruleLoc: number): Catalog[] {
    const baseRule = this.rule
    const atoms: Predicate[] = []
    const negatedAtoms: Predicate[] = []
    const cmprs: Predicate[] = []
    for (const predicate of baseRule.rhs) {
      switch (predicate.kind) {
        case 'Atom':
          atoms.push(predicate)
          break
        case 'NegatedAtom':
          negatedAtoms.push(predicate)
          break
        case 'Compare':
          cmprs.push(predicate)
          break
      }
    }

    const isActiveNonCoreAtomBitmap = this.isCoreAtomBitmap.map((c) => !c)
    const isActiveNegationBitmap = this.negatedAtomNames.map(() => true)
    const coreIds: number[] = []
    for (let i = 0; i < this.isCoreAtomBitmap.length; i++) {
      if (this.isCoreAtomBitmap[i]) coreIds.push(i)
    }

    const forward = this.reducer(
      `sip${ruleLoc}f`,
      baseRule,
      coreIds,
      atoms,
      negatedAtoms,
      cmprs,
      isActiveNonCoreAtomBitmap,
      isActiveNegationBitmap,
    ).map((rule) => Catalog.fromStrata(rule))

    const backward = this.reducer(
      `sip${ruleLoc}b`,
      baseRule,
      [...coreIds].reverse(),
      atoms,
      negatedAtoms,
      cmprs,
      isActiveNonCoreAtomBitmap,
      isActiveNegationBitmap,
    ).map((rule) => Catalog.fromStrata(rule))

    if (isActiveNonCoreAtomBitmap.some((x) => x)) {
      throw new Error('all non-core atoms should be consumed by SIP')
    }

    const finalHead = baseRule.head
    const cores: Predicate[] = []
    for (let i = 0; i < atoms.length; i++) {
      if (this.isCoreAtomBitmap[i]) cores.push(atoms[i]!)
    }
    const activeNeg: Predicate[] = []
    for (let i = 0; i < negatedAtoms.length; i++) {
      if (isActiveNegationBitmap[i]) activeNeg.push(negatedAtoms[i]!)
    }
    const finalRhs = [...cores, ...activeNeg, ...cmprs]
    const finalRule = new FLRule(finalHead, finalRhs, baseRule.isPlanning, baseRule.isSip)

    return [...forward, ...backward, Catalog.fromStrata(finalRule)]
  }

  /** Internal helper for `sideways()` — produces the per-direction sideway rules. */
  private reducer(
    suffix: string,
    baseRule: FLRule,
    coreIds: readonly number[],
    atoms: Predicate[],
    negatedAtoms: readonly Predicate[],
    cmprs: readonly Predicate[],
    isActiveNonCoreAtomBitmap: boolean[],
    isActiveNegationBitmap: boolean[],
  ): FLRule[] {
    const sidewayRules: FLRule[] = []

    for (let i = 0; i < coreIds.length; i++) {
      const coreId = coreIds[i]!
      const baseArgumentSignatures = this.atomArgumentSignatures[coreId]!
      const baseArguments = this.signatureToArgumentStrs(baseArgumentSignatures)
      const baseArgumentsSet = new Set<string>()
      const sidewayVars: string[] = []
      for (const arg of baseArguments) {
        if (!baseArgumentsSet.has(arg)) {
          baseArgumentsSet.add(arg)
          sidewayVars.push(arg)
        }
      }

      const subatomIds: number[] = []
      for (const subatomSig of this.subAtoms(baseArgumentSignatures)) {
        const subatomId = subatomSig.rhsId
        if (isActiveNonCoreAtomBitmap[subatomId]) {
          isActiveNonCoreAtomBitmap[subatomId] = false
          subatomIds.push(subatomId)
        }
      }

      const negatedAtomIds: number[] = []
      for (const negSig of this.subNegatedAtoms(baseArgumentSignatures)) {
        const negId = negSig.rhsId
        if (isActiveNegationBitmap[negId]) {
          isActiveNegationBitmap[negId] = false
          negatedAtomIds.push(negId)
        }
      }

      const comparisonIds: number[] = []
      for (let ci = 0; ci < this.comparisonPredicatesVarsSet.length; ci++) {
        const varsSet = this.comparisonPredicatesVarsSet[ci]!
        if (Catalog.isStringSubset(varsSet, baseArgumentsSet)) {
          comparisonIds.push(ci)
        }
      }

      const corePred = atoms[coreId]!
      const corePredName = corePred.kind === 'Atom' ? corePred.atom.name : (() => {
        throw new Error('expected positive atom predicate at core position')
      })()
      const sidewayName = `${corePredName}_${suffix}${i}`
      const sidewayHead = new Head(
        sidewayName,
        sidewayVars.map((v) => ({ kind: 'Var' as const, name: v })),
      )

      // (1) start with the base atom.
      const sidewayRhs: Predicate[] = [corePred]

      // (2) stitch sub-atoms, negated atoms, and comparisons (subsets of base args).
      for (const subId of subatomIds) sidewayRhs.push(atoms[subId]!)
      for (const negId of negatedAtomIds) sidewayRhs.push(negatedAtoms[negId]!)
      for (const cmpId of comparisonIds) sidewayRhs.push(cmprs[cmpId]!)

      // (3) for each non-disjoint earlier core atom, insert with only join vars (others → _).
      for (let jn = 0; jn < i; jn++) {
        const jnId = coreIds[jn]!
        const atomArgs = this.signatureToArgumentStrs(this.atomArgumentSignatures[jnId]!)
        const atomArgsSet = new Set(atomArgs)
        const disjoint = Catalog.isDisjoint(baseArgumentsSet, atomArgsSet)
        if (disjoint) continue

        const jnPred = atoms[jnId]
        if (!jnPred || jnPred.kind !== 'Atom') continue
        const newArgs: AtomArg[] = []
        for (const atomArg of jnPred.atom.args) {
          if (atomArgIsVar(atomArg) && !baseArgumentsSet.has(atomArgAsVar(atomArg))) {
            newArgs.push({ kind: 'Placeholder' })
          } else {
            newArgs.push(atomArg)
          }
        }
        sidewayRhs.push({
          kind: 'Atom',
          atom: new Atom(jnPred.atom.name, newArgs),
        })
      }

      if (sidewayRhs.length === 1) {
        // Trivial rule (just the base atom) — skip.
        continue
      }

      // Rewrite the original atom in-place to its reduced form.
      atoms[coreId] = {
        kind: 'Atom',
        atom: new Atom(
          sidewayName,
          sidewayVars.map((v) => ({ kind: 'Var' as const, name: v })),
        ),
      }

      sidewayRules.push(
        new FLRule(sidewayHead, sidewayRhs, baseRule.isPlanning, baseRule.isSip),
      )
    }

    return sidewayRules
  }

  // -----------------------------
  // helpers
  // -----------------------------

  private static isStringSubset(
    a: ReadonlySet<string>,
    b: ReadonlySet<string>,
  ): boolean {
    if (a.size > b.size) return false
    for (const v of a) {
      if (!b.has(v)) return false
    }
    return true
  }

  private static isDisjoint(
    a: ReadonlySet<string>,
    b: ReadonlySet<string>,
  ): boolean {
    const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a]
    for (const v of smaller) {
      if (larger.has(v)) return false
    }
    return true
  }
}
