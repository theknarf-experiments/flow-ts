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

const VARS = ['a', 'b', 'c', 'd'] as const
/** Small domain, so joins actually hit. */
const DOMAIN = [0, 1, 2] as const

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
    const roll = d.next(10)
    if (allowPlaceholder && roll === 0) args.push('_')
    else if (roll === 1) args.push(String(d.pick(DOMAIN)))
    else args.push(d.pick(VARS))
  }
  // An atom that shares no variable with the rest of the body, and whose own
  // variables don't reach the head, is a cartesian factor the planner cannot
  // represent — see tests/executing/planner-gaps.test.ts. Tie every atom to
  // one already in scope so bodies stay connected.
  const isVar = (s: string): boolean => (VARS as readonly string[]).includes(s)
  if (bound && bound.length > 0) {
    const shared = d.pick(bound)
    if (!args.includes(shared)) args[d.next(rel.arity)] = shared
  } else if (!args.some(isVar)) {
    args[0] = d.pick(VARS)
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
  const edbs: GenRel[] = Array.from({ length: edbCount }, (_, i) => ({
    name: `E${i}`,
    arity: 1 + d.next(3),
  }))

  const idbCount = 1 + d.next(3)
  const idbs: GenRel[] = []
  const rules: string[] = []

  for (let i = 0; i < idbCount; i++) {
    // Only earlier IDBs are in scope, which is what keeps this acyclic.
    const available: GenRel[] = [...edbs, ...idbs]
    const ruleCount = 1 + d.next(2)
    let arity: number | null = null
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
        const v = d.pick(VARS)
        first.args[0] = v
        first.vars.push(v)
        positive.push(v)
      }

      const parts = atoms.map(render)

      // Negation, only over an EDB and only over variables already bound
      // positively — both required for a legal, stratified program. Constants
      // are kept out of negated atoms: combined with a comparison they hit a
      // planner gap (tests/executing/planner-gaps.test.ts).
      if (d.chance(25)) {
        const rel = d.pick(edbs)
        parts.push(
          `!${rel.name}(${Array.from({ length: rel.arity }, () => d.pick(positive)).join(', ')})`,
        )
      }

      // A comparison, to exercise replay of filters.
      if (d.chance(20)) {
        parts.push(`${d.pick(positive)} < ${d.pick(DOMAIN) + 1}`)
      }

      // Head: a non-empty prefix of the positively-bound variables. Fixed
      // across a relation's rules, since they share one declaration.
      const headVars = positive.slice(0, arity ?? 1 + d.next(positive.length))
      if (arity === null) arity = headVars.length
      while (headVars.length < arity) headVars.push(positive[0]!)

      texts.push(`I${i}(${headVars.join(', ')}) :- ${parts.join(', ')}.`)
    }

    const self: GenRel = { name: `I${i}`, arity: arity ?? 1 }

    // A recursive rule: the relation's own body references itself, so it lands
    // in an SCC and the shadow rules for it are recursive too — their fixpoint
    // is the support set. Recursion is only ever through *positive* atoms here,
    // which is what keeps the program stratified.
    if (recursive && d.chance(70)) {
      const carried = Array.from({ length: self.arity }, (_, j) => VARS[j % VARS.length]!)
      const link = buildAtom(d, d.pick(edbs), false, carried)
      // Head variables must be bound positively; `carried` and the link atom's
      // variables are, so draw from those.
      const bound = [...new Set([...carried, ...link.vars])]
      const headVars = Array.from(
        { length: self.arity },
        (_, j) => bound[(j + 1) % bound.length]!,
      )
      texts.push(`${self.name}(${headVars.join(', ')}) :- ${self.name}(${carried.join(', ')}), ${render(link)}.`)
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
      const row: Row = Array.from({ length: e.arity }, () => d.pick(DOMAIN))
      rows.set(row.join(','), row)
    }
    facts[e.name] = [...rows.values()]
  }

  const decl = (r: GenRel) =>
    `.decl ${r.name}(${Array.from({ length: r.arity }, (_, i) => `c${i}: number`).join(', ')})`

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
