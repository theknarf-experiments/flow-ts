// Recovering the column types of derived relations.
//
// `.decl Foo()` is legal: the arity is left to the rules, and nothing needed the
// types because IDB rows only ever flow *out* of the engine. Feeding rows *in*
// is different — a fact channel needs a codec per column — so anything that
// wants to seed a derived relation has to know them. That's what the shadow
// compiler needs for `Seed_R`, and it's why flow-md's `.decl Q<hash>()` queries
// were unreachable from the backward path.
//
// The types were never really missing, only unwritten. A head variable comes
// from some body position, and that position has a declared type; aggregates
// and arithmetic have known result types; constants carry their own. So this
// walks each rule head back into its body, and iterates to a fixpoint so that
// IDBs defined over other IDBs — and recursive relations, which resolve through
// their base rule — settle too.
//
// It infers rather than asserts: a relation whose columns two rules disagree
// about, or which nothing pins down, is reported as unresolved with a reason
// instead of being given a plausible-looking guess.

import {
  type Arithmetic,
  type DataType,
  type FLRule,
  type Predicate,
  type Program,
} from '../ast/index.js'

export interface UnresolvedRelation {
  rel: string
  reason: string
}

export interface InferredTypes {
  /** Relation → column types, for those fully determined. Includes EDBs, which
   *  were declared all along. */
  types: Map<string, DataType[]>
  /** Relations left undetermined, and why. */
  unresolved: UnresolvedRelation[]
}

/** Column types for every relation the program can pin down. */
export function inferRelationTypes(program: Program): InferredTypes {
  const types = new Map<string, DataType[]>()
  const arity = new Map<string, number>()

  // Declared types win outright — an explicit `.decl` is a statement, not a
  // hypothesis, and inference has no business overriding it.
  for (const decl of [...program.edbs, ...program.idbs]) {
    if (decl.attributes.length > 0) {
      types.set(decl.name, decl.attributes.map((a) => a.dataType))
      arity.set(decl.name, decl.attributes.length)
    }
  }
  for (const rule of program.rules) {
    if (!arity.has(rule.head.name)) arity.set(rule.head.name, rule.head.headArguments.length)
  }

  const rulesByHead = new Map<string, FLRule[]>()
  for (const rule of program.rules) {
    const list = rulesByHead.get(rule.head.name) ?? []
    list.push(rule)
    rulesByHead.set(rule.head.name, list)
  }

  const conflicts = new Map<string, string>()

  // Fixpoint: each pass may resolve a relation whose body mentions one resolved
  // on the previous pass. Bounded by the number of relations, since every pass
  // that changes nothing ends it.
  for (let pass = 0; pass <= rulesByHead.size; pass++) {
    let learned = false
    for (const [name, rules] of rulesByHead) {
      if (types.has(name) || conflicts.has(name)) continue
      const resolved = resolveHead(name, rules, types, conflicts)
      if (resolved) {
        types.set(name, resolved)
        learned = true
      }
    }
    if (!learned) break
  }

  // Second pass. A recursive relation resolves from its base rule while its
  // recursive rule is still unresolvable — that rule mentions the very type
  // being derived — so it can only be checked once the fixpoint has settled.
  // Doing it here rather than during the fixpoint is what lets recursion work
  // at all, and it still catches a rule that genuinely disagrees.
  for (const [name, rules] of rulesByHead) {
    const known = types.get(name)
    if (!known || conflicts.has(name)) continue
    for (const rule of rules) {
      const fromRule = ruleHeadTypes(rule, types)
      if (!fromRule) continue // still unresolvable; nothing to contradict
      if (fromRule.length !== known.length) {
        conflicts.set(name, `rules for "${name}" disagree about its arity`)
        break
      }
      const clash = fromRule.findIndex((t, i) => widen(known[i]!, t) === null)
      if (clash >= 0) {
        conflicts.set(
          name,
          `rules for "${name}" disagree about column ${clash}: ${known[clash]} vs ${fromRule[clash]}`,
        )
        break
      }
    }
    if (conflicts.has(name)) types.delete(name)
  }

  const unresolved: UnresolvedRelation[] = []
  for (const decl of program.idbs) {
    if (types.has(decl.name)) continue
    const conflict = conflicts.get(decl.name)
    unresolved.push({
      rel: decl.name,
      reason:
        conflict ??
        (rulesByHead.has(decl.name)
          ? `no rule for "${decl.name}" pins down every column`
          : `"${decl.name}" is declared with no attributes and has no rules`),
    })
  }
  return { types, unresolved }
}

/** Column types for one head, or null if any column is still undetermined. */
function resolveHead(
  name: string,
  rules: readonly FLRule[],
  types: ReadonlyMap<string, DataType[]>,
  conflicts: Map<string, string>,
): DataType[] | null {
  let out: DataType[] | null = null

  for (const rule of rules) {
    const fromRule = ruleHeadTypes(rule, types)
    // A rule that can't be resolved yet is skipped rather than fatal: the
    // recursive rule of a recursive relation is always in that state on the
    // pass where its base rule settles the type. The second pass re-checks it.
    if (!fromRule) continue
    if (!out) {
      out = fromRule
      continue
    }
    if (out.length !== fromRule.length) {
      conflicts.set(name, `rules for "${name}" disagree about its arity`)
      return null
    }
    for (let i = 0; i < out.length; i++) {
      if (out[i] === fromRule[i]) continue
      // Integer and Float share a representation, so widening is safe and is
      // what a mixed-arithmetic program means. Anything else is a real clash.
      const widened = widen(out[i]!, fromRule[i]!)
      if (!widened) {
        conflicts.set(
          name,
          `rules for "${name}" disagree about column ${i}: ${out[i]} vs ${fromRule[i]}`,
        )
        return null
      }
      out[i] = widened
    }
  }
  return out
}

/** The least type holding both, or null if there isn't one.
 *
 *  Two widenings, and the difference between them matters. Integer and Float
 *  share a runtime representation, so a program that mixes them means the
 *  float. `Any` absorbs anything, because that is what declaring it says.
 *
 *  What deliberately does *not* widen is String against Integer. There is a
 *  type holding both — `Any` — and reaching for it here would turn every
 *  genuine disagreement between two rules into a silent success. `Any` is a
 *  thing you declare, not a thing inference falls back on. */
function widen(a: DataType, b: DataType): DataType | null {
  if (a === b) return a
  if (a === 'Any' || b === 'Any') return 'Any'
  if ((a === 'Integer' && b === 'Float') || (a === 'Float' && b === 'Integer')) return 'Float'
  return null
}

/** Types this one rule's head produces, or null if a column can't be pinned. */
function ruleHeadTypes(
  rule: FLRule,
  types: ReadonlyMap<string, DataType[]>,
): DataType[] | null {
  const varTypes = bodyVarTypes(rule.rhs, types)
  const out: DataType[] = []

  for (const ha of rule.head.headArguments) {
    switch (ha.kind) {
      case 'Var': {
        const t = varTypes.get(ha.name)
        if (!t) return null
        out.push(t)
        break
      }
      case 'Arith': {
        const t = arithType(ha.arithmetic, varTypes)
        if (!t) return null
        out.push(t)
        break
      }
      case 'Aggregation': {
        // `count` counts, whatever it counts. The rest carry their operand's
        // type through: a min of floats is a float.
        if (ha.aggregation.operator === 'Count') {
          out.push('Integer')
          break
        }
        const t = arithType(ha.aggregation.arithmetic, varTypes)
        if (!t) return null
        out.push(t)
        break
      }
    }
  }
  return out
}

/** Types of the variables a rule body binds positively. */
function bodyVarTypes(
  rhs: readonly Predicate[],
  types: ReadonlyMap<string, DataType[]>,
): Map<string, DataType> {
  const out = new Map<string, DataType>()
  for (const p of rhs) {
    // Negated atoms bind nothing — every variable in one must already be bound
    // positively — so they can only repeat what's known.
    if (p.kind !== 'Atom') continue
    const cols = types.get(p.atom.name)
    if (!cols || cols.length !== p.atom.args.length) continue
    p.atom.args.forEach((arg, i) => {
      if (arg.kind !== 'Var' || out.has(arg.name)) return
      out.set(arg.name, cols[i]!)
    })
  }
  return out
}

/** Result type of an arithmetic expression, or null if an operand is unknown. */
function arithType(
  arith: Arithmetic,
  varTypes: ReadonlyMap<string, DataType>,
): DataType | null {
  const factors = [arith.init, ...arith.rest.map(([, f]) => f)]
  let out: DataType | null = null
  for (const f of factors) {
    let t: DataType | null
    if (f.kind === 'Var') {
      t = varTypes.get(f.name) ?? null
    } else {
      t =
        f.value.kind === 'Text' ? 'String' : f.value.kind === 'Float' ? 'Float' : 'Integer'
    }
    if (!t) return null
    // A bare value passes through as itself; a real expression is numeric, and
    // mixing an integer with a float yields a float.
    out = out === null ? t : (widen(out, t) ?? out)
  }
  return out
}
