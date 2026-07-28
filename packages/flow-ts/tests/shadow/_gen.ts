// A generator of small, valid, stratified Datalog programs, for fuzzing the
// shadow compiler against the forward engine.
//
// Hand-picked shapes only test the cases you thought of. The interesting
// failures in a compiler like this come from combinations — a placeholder in
// an atom that also carries a constant, a variable shared by three atoms, an
// IDB used twice in one body — and those are what random programs reach.
//
// Rather than compose fast-check combinators (painful for something this
// structured, and it shrinks badly), the generator consumes a flat array of
// naturals through a cursor and builds deterministically. fast-check shrinks
// the array, which shrinks the program.
//
// Invariants the builder maintains, so every program it emits is legal:
//   • Safety — every head variable, and every variable under negation,
//     appears in a positive body atom.
//   • Existence tests are emitted on purpose — an atom sharing no variable with
//     the rest of the body, whose own variables never reach the head.
//   • Stratification — a rule body only references EDBs and *earlier* IDBs,
//     and negation only ever applies to an EDB. No cycles, so no recursion.
//     (Recursion is covered by a dedicated test; here it would just make
//     "which program is this" harder to read off a counterexample.)
//   • Non-empty bodies and heads.

import fc from 'fast-check'
import type { Row } from '../../src/reading/index.js'

export interface GenRel {
  name: string
  arity: number
  cols: ColType[]
}

export interface GenProgram {
  source: string
  edbs: GenRel[]
  idbs: GenRel[]
  facts: Record<string, Row[]>
  /** Rule text, for counterexample reporting. */
  rules: string[]
}

/** Cursor over a flat pool of naturals. Deterministic, so shrinking the pool
 *  shrinks the program. */
class Draw {
  private i = 0
  constructor(private readonly pool: readonly number[]) {}
  next(mod: number): number {
    if (mod <= 0) return 0
    const v = this.pool[this.i % this.pool.length] ?? 0
    this.i++
    return v % mod
  }
  chance(percent: number): boolean {
    return this.next(100) < percent
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.next(xs.length)]!
  }
}

// Variables are typed, and a column only ever hosts one of its own type. The
// alternative — letting any variable land anywhere — generates programs that
// are legal but never join, and whose relations infer as type conflicts, so the
// interesting paths would go untested while coverage looked fine.
const NUM_VARS = ['a', 'b'] as const
const STR_VARS = ['s', 't'] as const
type ColType = 'number' | 'string'

/** Small domains, so joins actually hit. */
const NUM_DOMAIN = [0, 1, 2] as const
const STR_DOMAIN = ['x', 'y'] as const

const varsOfType = (t: ColType): readonly string[] => (t === 'number' ? NUM_VARS : STR_VARS)
const literalOfType = (d: Draw, t: ColType): string =>
  t === 'number' ? String(d.pick(NUM_DOMAIN)) : `"${d.pick(STR_DOMAIN)}"`
const isVarName = (x: string): boolean =>
  (NUM_VARS as readonly string[]).includes(x) || (STR_VARS as readonly string[]).includes(x)
const typeOfVar = (v: string): ColType =>
  (NUM_VARS as readonly string[]).includes(v) ? 'number' : 'string'

interface BuiltAtom {
  rel: GenRel
  /** Rendered argument list. */
  args: string[]
  /** Variables occurring positively in it. */
  vars: string[]
}

function buildAtom(
  d: Draw,
  rel: GenRel,
  allowPlaceholder: boolean,
  bound?: readonly string[],
): BuiltAtom {
  const args: string[] = []
  for (let i = 0; i < rel.arity; i++) {
    const t = rel.cols[i]!
    const roll = d.next(10)
    if (allowPlaceholder && roll === 0) args.push('_')
    else if (roll === 1) args.push(literalOfType(d, t))
    else args.push(d.pick(varsOfType(t)))
  }
  // Bodies are usually tied together, but not always: an atom sharing nothing
  // with the rest is an existence test, and those are supported now, so the
  // generator emits them deliberately rather than avoiding them.
  const isVar = isVarName
  // Tie to something already in scope, but only where the types line up.
  if (bound && bound.length > 0 && d.chance(80)) {
    const shared = d.pick(bound)
    const slots = rel.cols
      .map((t, i) => (t === typeOfVar(shared) ? i : -1))
      .filter((i) => i >= 0)
    if (slots.length > 0 && !args.includes(shared)) args[d.pick(slots)] = shared
  } else if (!bound && !args.some(isVar)) {
    args[0] = d.pick(varsOfType(rel.cols[0]!))
  }
  // Derive the bound set from the *final* arguments. Deriving it as we go was
  // a bug: the tie-in above overwrites a position, so a variable counted on
  // the way in could be gone by the end — and a rule whose comparison names a
  // variable no positive atom binds is unsafe.
  return { rel, args, vars: [...new Set(args.filter(isVar))] }
}

const render = (a: BuiltAtom): string => `${a.rel.name}(${a.args.join(', ')})`

export function buildProgram(pool: readonly number[], recursive = false): GenProgram {
  const d = new Draw(pool)

  const edbCount = 1 + d.next(3)
  const edbs: GenRel[] = Array.from({ length: edbCount }, (_, i) => {
    const arity = 1 + d.next(3)
    return {
      name: `E${i}`,
      arity,
      // Mixed columns, so the codec and type-inference paths are reachable.
      cols: Array.from({ length: arity }, () =>
        d.chance(35) ? ('string' as const) : ('number' as const),
      ),
    }
  })

  const idbCount = 1 + d.next(3)
  const idbs: GenRel[] = []
  const rules: string[] = []

  for (let i = 0; i < idbCount; i++) {
    // Only earlier IDBs are in scope, which is what keeps this acyclic.
    const available: GenRel[] = [...edbs, ...idbs]
    const ruleCount = 1 + d.next(2)
    let arity: number | null = null
    let headCols: ColType[] | null = null
    const texts: string[] = []

    for (let r = 0; r < ruleCount; r++) {
      const bodyLen = 1 + d.next(3)
      const atoms: BuiltAtom[] = []
      const inScope: string[] = []
      for (let b = 0; b < bodyLen; b++) {
        const atom = buildAtom(d, d.pick(available), true, inScope)
        atoms.push(atom)
        for (const v of atom.vars) if (!inScope.includes(v)) inScope.push(v)
      }
      const positive = [...new Set(atoms.flatMap((a) => a.vars))]
      if (positive.length === 0) {
        // Nothing to put in the head; force one variable into the first atom.
        const first = atoms[0]!
        const v = d.pick(varsOfType(first.rel.cols[0]!))
        first.args[0] = v
        first.vars.push(v)
        positive.push(v)
      }

      const parts = atoms.map(render)

      // Negation, only over an EDB and only over variables already bound
      // positively — both required for a legal, stratified program. Constants
      // in negated atoms are included: they used to hit a planner gap when the
      // body also carried a comparison, which is how that bug was found.
      if (d.chance(25)) {
        const rel = d.pick(edbs)
        const args = rel.cols.map((t) => {
          const candidates = positive.filter((v) => typeOfVar(v) === t)
          if (candidates.length === 0 || d.next(5) === 0) return literalOfType(d, t)
          return d.pick(candidates)
        })
        parts.push(`!${rel.name}(${args.join(', ')})`)
      }

      // A comparison, to exercise replay of filters. Same-typed operands only:
      // a number/string compare is a runtime error, not an interesting program.
      if (d.chance(20)) {
        const v = d.pick(positive)
        parts.push(
          typeOfVar(v) === 'number'
            ? `${v} < ${d.pick(NUM_DOMAIN) + 1}`
            : `${v} < "${d.pick(STR_DOMAIN)}"`,
        )
      }

      // Head: a non-empty prefix of the positively-bound variables. Fixed
      // across a relation's rules, since they share one declaration.
      // A relation's rules share one declaration, so its column types are fixed
      // by whichever rule got there first and every later rule has to line up.
      // A rule that can't supply a variable of the required type is dropped
      // rather than bent into shape: emitting it anyway produces a program whose
      // declared types contradict what it derives, and the engine doesn't
      // type-check, so that would silently poison everything downstream.
      let headVars: string[]
      if (headCols === null) {
        headVars = positive.slice(0, 1 + d.next(positive.length))
        while (headVars.length < (arity ?? headVars.length)) headVars.push(positive[0]!)
        arity = headVars.length
        headCols = headVars.map(typeOfVar)
      } else {
        const chosen: string[] = []
        for (const want of headCols) {
          const candidates = positive.filter((v) => typeOfVar(v) === want)
          if (candidates.length === 0) break
          chosen.push(d.pick(candidates))
        }
        if (chosen.length !== headCols.length) continue // can't type this rule
        headVars = chosen
      }

      texts.push(`I${i}(${headVars.join(', ')}) :- ${parts.join(', ')}.`)
    }

    const self: GenRel = {
      name: `I${i}`,
      arity: arity ?? 1,
      cols: headCols ?? [Array.from(['number' as ColType])[0]!],
    }

    // A recursive rule: the relation's own body references itself, so it lands
    // in an SCC and the shadow rules for it are recursive too — their fixpoint
    // is the support set. Recursion is only ever through *positive* atoms here,
    // which is what keeps the program stratified.
    if (recursive && d.chance(70)) {
      const carried = self.cols.map((t, j) => varsOfType(t)[j % varsOfType(t).length]!)
      const link = buildAtom(d, d.pick(edbs), false, carried)
      // Head variables must be bound positively; `carried` and the link atom's
      // variables are, so draw from those.
      const bound = [...new Set([...carried, ...link.vars])]
      // The recursive rule shares the relation's declaration too, so its head
      // has to match column for column. Prefer a variable the link atom brought
      // in rather than one already carried: that is the transitive-closure
      // shape, and it keeps the rule from being its own support.
      const linkOnly = link.vars.filter((v) => !carried.includes(v))
      const headVars = self.cols.map((t) => {
        const preferred = linkOnly.filter((v) => typeOfVar(v) === t)
        if (preferred.length > 0) return d.pick(preferred)
        const candidates = bound.filter((v) => typeOfVar(v) === t)
        return candidates.length > 0 ? d.pick(candidates) : null
      })
      // A rule whose head is identical to its recursive atom is its own
      // support: it adds nothing to the least fixpoint, since it can only
      // re-derive what is already there. Retraction handles it correctly now
      // (tests/executing/recursive-retraction.test.ts), but generating it would
      // still spend the budget on a shape no real program writes.
      const tautological = headVars.every((v, j) => v === carried[j])
      if (headVars.every((v) => v !== null) && !tautological) {
        texts.push(
          `${self.name}(${headVars.join(', ')}) :- ${self.name}(${carried.join(', ')}), ${render(link)}.`,
        )
      }
    }

    idbs.push(self)
    rules.push(...texts)
  }

  // Facts: a random subset of the small domain's product, deduped.
  const facts: Record<string, Row[]> = {}
  for (const e of edbs) {
    const rows = new Map<string, Row>()
    const n = d.next(6)
    for (let k = 0; k < n; k++) {
      const row: Row = e.cols.map((t) => (t === 'number' ? d.pick(NUM_DOMAIN) : d.pick(STR_DOMAIN)))
      rows.set(row.join(','), row)
    }
    facts[e.name] = [...rows.values()]
  }

  const decl = (r: GenRel) =>
    `.decl ${r.name}(${r.cols.map((t, i) => `c${i}: ${t}`).join(', ')})`

  const source = [
    '.in',
    ...edbs.flatMap((e) => [decl(e), `.input ${e.name}.csv`]),
    '.printsize',
    ...idbs.map(decl),
    '.rule',
    ...rules,
  ].join('\n')

  return { source, edbs, idbs, facts, rules }
}

/** Programs, via a shrinkable pool of naturals. */
export const programGen: fc.Arbitrary<GenProgram> = fc
  .array(fc.nat({ max: 1000 }), { minLength: 60, maxLength: 60 })
  .map((pool) => buildProgram(pool))

/** The same, with recursive rules — so shadow rules land inside an SCC. */
export const recursiveProgramGen: fc.Arbitrary<GenProgram> = fc
  .array(fc.nat({ max: 1000 }), { minLength: 60, maxLength: 60 })
  .map((pool) => buildProgram(pool, true))
