// Property-based tests for Catalog invariants over randomly generated rules.

import {
  Arithmetic,
  Atom,
  type AtomArg,
  ComparisonExpr,
  FLRule,
  Head,
  type Predicate,
} from 'flow-ts'
import fc from 'fast-check'
import { describe, it } from 'vitest'
import { type AtomSignature, Catalog } from '../../src/catalog/index.js'

const VAR_POOL = ['x', 'y', 'z', 'w'] as const
const REL_POOL = ['A', 'B', 'C'] as const

// Atom argument: weight Vars heavily; some Consts and Placeholders.
const atomArgGen: fc.Arbitrary<AtomArg> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc
      .constantFrom(...VAR_POOL)
      .map((name) => ({ kind: 'Var', name }) as AtomArg),
  },
  {
    weight: 1,
    arbitrary: fc
      .integer({ min: 0, max: 9 })
      .map(
        (n) =>
          ({
            kind: 'Const',
            value: { kind: 'Integer', value: Number(n) },
          }) as AtomArg,
      ),
  },
  { weight: 1, arbitrary: fc.constant({ kind: 'Placeholder' } as AtomArg) },
)

const atomGen: fc.Arbitrary<Atom> = fc
  .tuple(
    fc.constantFrom(...REL_POOL),
    fc.array(atomArgGen, { minLength: 1, maxLength: 3 }),
  )
  .map(([name, args]) => new Atom(name, args))

const positivePredicateGen: fc.Arbitrary<Predicate> = atomGen.map(
  (atom) => ({ kind: 'Atom', atom }) as Predicate,
)

// Generate a positive-only rule. Catalog.fromStrata has a safety check on
// negated atoms, so the simplest valid-rule generator avoids negation.
const ruleArb: fc.Arbitrary<FLRule> = fc
  .array(positivePredicateGen, { minLength: 1, maxLength: 5 })
  .map((rhs) => {
    // Head var: an arbitrary bound variable, falling back to "x".
    let headVar = 'x'
    outer: for (const p of rhs) {
      if (p.kind !== 'Atom') continue
      for (const arg of p.atom.args) {
        if (arg.kind === 'Var') {
          headVar = arg.name
          break outer
        }
      }
    }
    const head = new Head('R', [{ kind: 'Var', name: headVar }])
    return new FLRule(head, rhs, false, false)
  })

function argStringsForAtom(cat: Catalog, atomIdx: number): Set<string> {
  return new Set(
    cat.signatureToArgumentStrs(cat.atomArgumentSignatures[atomIdx]!),
  )
}

function isSubset<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size > b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

describe('Catalog — properties', () => {
  it('signatureToArgumentStrMap keys are exactly the Var-argument positions', () => {
    fc.assert(
      fc.property(ruleArb, (rule) => {
        const cat = Catalog.fromStrata(rule)
        for (let i = 0; i < cat.atomNames.length; i++) {
          const atomPred = rule.rhs[i]
          if (!atomPred || atomPred.kind !== 'Atom') continue
          const sigs = cat.atomArgumentSignatures[i]!
          for (let j = 0; j < sigs.length; j++) {
            const sig = sigs[j]!
            const arg = atomPred.atom.args[j]!
            const inMap = cat.signatureToArgumentStrMap.has(sig)
            if (arg.kind === 'Var') {
              if (!inMap) return false
              if (cat.signatureToArgumentStrMap.get(sig) !== arg.name) return false
            } else {
              if (inMap) return false
            }
          }
        }
        return true
      }),
    )
  })

  it('argumentPresenceMap entries are consistent with the signature map', () => {
    fc.assert(
      fc.property(ruleArb, (rule) => {
        const cat = Catalog.fromStrata(rule)
        for (const [variable, presence] of cat.argumentPresenceMap.entries()) {
          if (presence.length !== cat.atomArgumentSignatures.length) return false
          for (const sig of presence) {
            if (sig === null) continue
            if (cat.signatureToArgumentStrMap.get(sig) !== variable) return false
            // Non-null presence entries are never base-filtered positions.
            if (cat.isConstOrVarEqOrPlaceholder(sig)) return false
          }
        }
        return true
      }),
    )
  })

  it('every safe variable used outside base-filters appears in argumentPresenceMap', () => {
    fc.assert(
      fc.property(ruleArb, (rule) => {
        const cat = Catalog.fromStrata(rule)
        for (let i = 0; i < cat.atomArgumentSignatures.length; i++) {
          for (const sig of cat.atomArgumentSignatures[i]!) {
            if (cat.isConstOrVarEqOrPlaceholder(sig)) continue
            const v = cat.signatureToArgumentStrMap.get(sig)
            if (v === undefined) continue
            const presence = cat.argumentPresenceMap.get(v)
            if (!presence) return false
            if (presence[i] === null) return false
          }
        }
        return true
      }),
    )
  })

  it('isCoreAtomBitmap: every non-core atom is a subset of some other atom', () => {
    fc.assert(
      fc.property(ruleArb, (rule) => {
        const cat = Catalog.fromStrata(rule)
        const argSets = cat.atomArgumentSignatures.map((_, i) =>
          argStringsForAtom(cat, i),
        )
        for (let i = 0; i < cat.isCoreAtomBitmap.length; i++) {
          if (cat.isCoreAtomBitmap[i]) continue
          // Must exist some j ≠ i with argSets[i] ⊆ argSets[j].
          let found = false
          for (let j = 0; j < argSets.length; j++) {
            if (i === j) continue
            if (isSubset(argSets[i]!, argSets[j]!)) {
              found = true
              break
            }
          }
          if (!found) return false
        }
        return true
      }),
    )
  })

  it('isCoreAtomBitmap: when multiple atoms have identical arg sets, only the lowest index is core', () => {
    fc.assert(
      fc.property(ruleArb, (rule) => {
        const cat = Catalog.fromStrata(rule)
        const argSets = cat.atomArgumentSignatures.map((_, i) =>
          argStringsForAtom(cat, i),
        )
        const eqKey = (s: Set<string>) =>
          [...s].sort().join('')
        const groups = new Map<string, number[]>()
        for (let i = 0; i < argSets.length; i++) {
          const k = eqKey(argSets[i]!)
          const arr = groups.get(k) ?? []
          arr.push(i)
          groups.set(k, arr)
        }
        for (const indices of groups.values()) {
          if (indices.length === 1) continue
          // The lowest index might be core (or non-core if a strict superset
          // exists elsewhere); every other index in the same equivalence
          // class must be non-core.
          const sortedIndices = [...indices].sort((a, b) => a - b)
          for (const idx of sortedIndices.slice(1)) {
            if (cat.isCoreAtomBitmap[idx]) return false
          }
        }
        return true
      }),
    )
  })

  it('subAtoms returns only non-core atoms whose arg set is a subset', () => {
    fc.assert(
      fc.property(ruleArb, (rule) => {
        const cat = Catalog.fromStrata(rule)
        for (let i = 0; i < cat.atomArgumentSignatures.length; i++) {
          if (!cat.isCoreAtomBitmap[i]) continue
          const argSet = argStringsForAtom(cat, i)
          const results: AtomSignature[] = cat.subAtoms(
            cat.atomArgumentSignatures[i]!,
          )
          for (const r of results) {
            if (!r.isPositive) return false
            if (cat.isCoreAtomBitmap[r.rhsId]) return false
            const subSet = argStringsForAtom(cat, r.rhsId)
            if (!isSubset(subSet, argSet)) return false
          }
        }
        return true
      }),
    )
  })

  it('dependentAtomNames equals union of atomNames and negatedAtomNames', () => {
    fc.assert(
      fc.property(ruleArb, (rule) => {
        const cat = Catalog.fromStrata(rule)
        const expected = new Set<string>([
          ...cat.atomNames,
          ...cat.negatedAtomNames,
        ])
        const got = cat.dependentAtomNames()
        if (got.size !== expected.size) return false
        for (const n of expected) if (!got.has(n)) return false
        return true
      }),
    )
  })

  it('partitionComparisonPredicates routes each predicate to the correct buckets', () => {
    // Compose a rule with comparison predicates manually so we can control
    // which variables appear on each side.
    const ruleWithComparisons = fc.tuple(
      fc.array(positivePredicateGen, { minLength: 2, maxLength: 4 }),
      fc.array(
        fc.tuple(
          fc.constantFrom(...VAR_POOL),
          fc.constantFrom(...VAR_POOL),
        ),
        { minLength: 1, maxLength: 3 },
      ),
    )
      .map(([atoms, comparisonPairs]) => {
        const cmpPredicates: Predicate[] = comparisonPairs.map(([a, b]) => {
          const left = new Arithmetic({ kind: 'Var', name: a }, [])
          const right = new Arithmetic({ kind: 'Var', name: b }, [])
          return {
            kind: 'Compare',
            expr: new ComparisonExpr(left, 'NotEquals', right),
          }
        })
        const rhs: Predicate[] = [...atoms, ...cmpPredicates]
        const head = new Head('R', [{ kind: 'Var', name: 'x' }])
        return new FLRule(head, rhs, false, false)
      })

    fc.assert(
      fc.property(ruleWithComparisons, (rule) => {
        const cat = Catalog.fromStrata(rule)
        if (cat.comparisonPredicates.length === 0) return true
        const activeIds = cat.comparisonPredicates.map((_, i) => i)

        // Pick a partition of variable names into "left" and "right".
        const leftVars = new Set<string>(VAR_POOL.slice(0, 2))
        const rightVars = new Set<string>(VAR_POOL.slice(2))

        // The partition function asserts vars must be a subset of the union;
        // since our pools are disjoint and cover all VAR_POOL entries, every
        // predicate's vars are ⊆ union.
        const { join, left, right } = cat.partitionComparisonPredicates(
          leftVars,
          rightVars,
          activeIds,
        )

        for (const i of activeIds) {
          const vars = cat.comparisonPredicates[i]!.varsSet()
          const inLeft = isSubset(vars, leftVars)
          const inRight = isSubset(vars, rightVars)

          if (inLeft && !left.includes(i)) return false
          if (inRight && !right.includes(i)) return false
          if (!inLeft && !inRight && !join.includes(i)) return false
          if (inLeft && inRight) {
            // Trivially both (e.g. vars is empty) — must be in both buckets.
            if (!left.includes(i) || !right.includes(i)) return false
          }
        }
        return true
      }),
    )
  })
})
