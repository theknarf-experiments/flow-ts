// The recursive shape incremental retraction still cannot undo.
//
// A recursive rule usually carries something out of its recursive atom:
//
//   T(x, z) :- T(x, y), Arc(y, z).
//
// `x` comes from `T`, so every derived `T(x, z)` is tied to the particular
// `T(x, y)` that produced it, and retracting that one removes this one. That
// case works — see tests/executing/recursive-retraction.test.ts.
//
// This one does not:
//
//   I0(t) :- I0(s), E0(t).
//
// `s` appears nowhere but the recursive atom — not in the head, not joined
// against anything, not compared. So `I0(s)` is a *guard*: it says "some I0
// exists" and contributes nothing else. The planner is right to project it down
// to the join key, which here is nothing at all, and that projection is where
// every distinct derivation of a row collapses into one. A row derived once
// from `I0("y")` and again from `I0("x")` arrives as a single fact about
// existence, so retracting `I0("y")` produces no delta while `I0("x")` remains,
// and `I0("x")` is deriving itself.
//
// The bar is low and almost everything clears it. Reachability —
//
//   R(y) :- R(x), Arc(x, y).
//
// — shares nothing with its head either, but `x` is a join key against `Arc`,
// so a row reached via `R(x1)` and a row reached via `R(x2)` stay two
// derivations. One variable of the recursive atom used anywhere else at all is
// enough.
//
// No dedup downstream can recover that, because the information is gone before
// it gets there. Fixing it needs the derivation to stay distinguishable through
// the join — differential-dataflow's nested product timestamps, which is what
// the sibling Rust engine keeps and what db-ivm traded away. Until then this
// says exactly which programs are affected, so callers that maintain a graph
// across retractions can refuse those rather than the whole of recursion.
//
// Batch evaluation is unaffected: it computes the fixpoint from nothing.

import type { Program } from '../ast/index.js'
import { Strata } from './stratification.js'

/** Variable names mentioned anywhere in a comparison, however nested. */
function variablesOf(node: unknown): string[] {
  if (node === null || typeof node !== 'object') return []
  const record = node as Record<string, unknown>
  if (record.kind === 'Var' && typeof record.name === 'string') return [record.name]
  const out: string[] = []
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) for (const v of value) out.push(...variablesOf(v))
    else out.push(...variablesOf(value))
  }
  return out
}

export interface GuardRecursion {
  /** The rule, as written. */
  rule: string
  /** The body atom whose variables never reach the head. */
  atom: string
}

/** Rules with a recursive atom whose variables appear nowhere else.
 *
 *  Empty for a program with no recursion, and for the recursive programs one
 *  actually writes — transitive closure, reachability, ancestry — every one of
 *  which either carries a variable to the head or joins one against something
 *  else. */
export function guardRecursiveRules(program: Program): GuardRecursion[] {
  const strata = Strata.fromParser(program)
  const found: GuardRecursion[] = []

  strata.strataIndices().forEach((ruleIds, stratumId) => {
    if (!strata.isRecursiveStratum(stratumId)) return
    // Heads defined in this stratum are the ones that can close a cycle; an
    // atom naming any of them is a recursive atom for this purpose.
    const inStratum = new Set<string>()
    for (const id of ruleIds) {
      const rule = program.rules[id]
      if (rule) inStratum.add(rule.head.name)
    }

    for (const id of ruleIds) {
      const rule = program.rules[id]
      if (!rule) continue
      // Everywhere a variable can be observed other than in the atom itself:
      // the head, the other body atoms, and the comparisons.
      const elsewhere = (self: unknown): Set<string> => {
        const seen = new Set<string>()
        for (const a of rule.head.headArguments) if (a.kind === 'Var') seen.add(a.name)
        for (const p of rule.rhs) {
          if (p === self) continue
          if (p.kind === 'Compare') {
            for (const name of variablesOf(p)) seen.add(name)
            continue
          }
          for (const a of p.atom.args) if (a.kind === 'Var') seen.add(a.name)
        }
        return seen
      }

      for (const p of rule.rhs) {
        if (p.kind === 'Compare') continue
        if (!inStratum.has(p.atom.name)) continue
        const atomVars = p.atom.args.flatMap((a) => (a.kind === 'Var' ? [a.name] : []))
        // A placeholder carries nothing either way. One named variable observed
        // anywhere else keeps this atom's derivations distinguishable.
        const seen = elsewhere(p)
        if (atomVars.some((v) => seen.has(v))) continue
        found.push({ rule: rule.toString(), atom: p.atom.name })
      }
    }
  })

  return found
}
