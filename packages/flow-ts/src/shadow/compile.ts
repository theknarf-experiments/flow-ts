// Shadow-rule compilation: the backward direction of a Datalog program,
// expressed as more Datalog.
//
// A forward rule says how derived tuples come to exist. Its *shadow* says the
// opposite: given a request to un-derive a tuple, which tuples could have
// supported it. The trick is that this is itself a conjunctive query — you
// take the original body, join the request onto it, and project onto one body
// atom:
//
//   Open(p, t)        :- Task(p, "open", t, l).
//   Del_Task(p,"open",t,l) :- Del_Open(p, t), Task(p, "open", t, l).
//
// Replaying the body is what recovers `l`, the column the view projected away.
// No separate lineage machinery, no per-cell provenance payload: the engine
// answers a question about its own program by running a program.
//
// Because the shadow relations are ordinary IDBs, a request walks *backwards*
// through the whole rule graph on its own — Del_Top derives Del_Mid derives
// Del_Base — and it does so incrementally, like everything else here.
//
// Channels. `Del_R` means "retract this tuple of R"; `Ins_R` means "insert
// it". Negation swaps them: one way to un-derive `Visible(x) :- Item(x),
// !Hidden(x)` is to drop the Item, and the other is to *add* the Hidden.
//
// Requests enter through `Seed_R`, an EDB the caller feeds. It's separate from
// `Del_R` because `Del_R` is derived (by the shadow rules of R's consumers)
// and a relation is either fed with facts or computed from them.
//
// What this does NOT do is choose. A rule body with several writable atoms
// produces several candidates, and the shadow relations hold all of them; the
// policy that picks one (or refuses) lives above this module. That separation
// is deliberate — ambiguity becomes data you can query rather than a static
// analysis that has to be conservative.

import {
  type Atom,
  type HeadArg,
  type Predicate,
  type Program,
  type RelDecl,
  atomArgToString,
  constToString,
  dataTypeToString,
  predicateToString,
} from '../ast/index.js'

export const SEED_PREFIX = 'Seed_'
export const DEL_PREFIX = 'Del_'
export const INS_PREFIX = 'Ins_'

/** A rule (or part of one) the compiler declined to invert. */
export interface ShadowRefusal {
  /** The offending rule as written, or a relation name for decl-level issues. */
  subject: string
  reason: string
}

export interface ShadowProgram {
  /** The original program plus shadow decls and rules, as `.dl` source. */
  source: string
  /** Relations that gained a `Seed_` channel, i.e. views you can request
   *  changes to. */
  seeds: string[]
  /** Everything the compiler could not invert, and why. */
  refusals: ShadowRefusal[]
}

interface ShadowRule {
  /** Shadow relation this rule derives, e.g. `Del_Task`. */
  headRel: string
  /** Shadow relations appearing in the body — the pruning dependency. */
  needs: string[]
  text: string
}

/** Compile the backward direction of `program` into shadow rules. */
export function compileShadow(program: Program): ShadowProgram {
  const refusals: ShadowRefusal[] = []
  const rules: ShadowRule[] = []
  const seeds: string[] = []

  const edbNames = new Set(program.edbs.map((d) => d.name))
  const declOf = new Map<string, RelDecl>()
  for (const d of [...program.edbs, ...program.idbs]) declOf.set(d.name, d)

  // A request enters on a view, so every IDB gets a seed. It has to become an
  // EDB of the shadow program, which means real attributes: `.decl H()` (arity
  // inferred from the rules) carries nothing to build a fact channel from.
  for (const idb of program.idbs) {
    if (idb.attributes.length === 0) {
      refusals.push({
        subject: idb.name,
        reason: `"${idb.name}" has an untyped .decl (no attributes), so no Seed_ EDB can be declared for it`,
      })
      continue
    }
    seeds.push(idb.name)
    const vars = seedVars(idb).join(', ')
    rules.push({
      headRel: DEL_PREFIX + idb.name,
      needs: [],
      text: `${DEL_PREFIX}${idb.name}(${vars}) :- ${SEED_PREFIX}${idb.name}(${vars}).`,
    })
  }

  for (const rule of program.rules) {
    const subject = rule.toString()

    // The head has to be invertible into an atom: plain variables (and bare
    // constants) only. Arithmetic and aggregation are where the forward
    // direction stops being a copy, and they need annotation, not inference.
    const headArgs: string[] = []
    let headOk = true
    for (const ha of rule.head.headArguments) {
      const rendered = headArgAsAtomArg(ha)
      if (rendered === null) {
        refusals.push({ subject, reason: refusalFor(ha) })
        headOk = false
        break
      }
      headArgs.push(rendered)
    }
    if (!headOk) continue

    const request = `${rule.head.name}(${headArgs.join(', ')})`
    const taken = varsOf(rule.rhs)
    let fresh = 0
    const nextVar = (): string => {
      let name = `_v${fresh++}`
      while (taken.has(name)) name = `_v${fresh++}`
      taken.add(name)
      return name
    }

    rule.rhs.forEach((pred, i) => {
      if (pred.kind === 'Compare') return
      const atom = pred.atom

      if (pred.kind === 'Atom') {
        // Placeholders carry no name, so they can't be projected into the
        // shadow head — give them one. Only in *this* atom's occurrence: the
        // rest of the body is replayed as written.
        const subst = new Map<number, string>()
        atom.args.forEach((a, j) => {
          if (a.kind === 'Placeholder') subst.set(j, nextVar())
        })
        const body = rule.rhs
          .map((p, j) => (j === i ? renderAtom(atom, subst) : predicateToString(p)))
          .join(', ')
        rules.push({
          headRel: DEL_PREFIX + atom.name,
          needs: [DEL_PREFIX + rule.head.name],
          text: `${DEL_PREFIX}${renderAtom(atom, subst)} :- ${DEL_PREFIX}${request}, ${body}.`,
        })
        return
      }

      // Negated atom: the polarity flips. Un-deriving the head can be achieved
      // by making the negation fail — i.e. inserting the tuple it excludes.
      if (atom.args.some((a) => a.kind === 'Placeholder')) {
        refusals.push({
          subject,
          reason: `negated atom ${atom.toString()} has a placeholder, so the tuple to insert is underdetermined`,
        })
        return
      }
      const body = rule.rhs.map((p) => predicateToString(p)).join(', ')
      rules.push({
        headRel: INS_PREFIX + atom.name,
        needs: [DEL_PREFIX + rule.head.name],
        text: `${INS_PREFIX}${renderAtom(atom)} :- ${DEL_PREFIX}${request}, ${body}.`,
      })
    })
  }

  const live = prune(rules)
  return {
    source: render(program, live, seeds, edbNames, declOf),
    seeds,
    refusals,
  }
}

// --- helpers ----------------------------------------------------------------

function headArgAsAtomArg(ha: HeadArg): string | null {
  if (ha.kind === 'Var') return ha.name
  if (ha.kind === 'Arith') {
    const a = ha.arithmetic
    if (a.rest.length > 0) return null
    return a.init.kind === 'Var' ? a.init.name : constToString(a.init.value)
  }
  return null
}

function refusalFor(ha: HeadArg): string {
  return ha.kind === 'Aggregation'
    ? `head argument ${ha.aggregation.toString()} is an aggregation — its inverse is a distribution policy, which has to be annotated`
    : `head argument ${ha.kind === 'Arith' ? ha.arithmetic.toString() : '?'} is arithmetic — not inverted yet`
}

/** Variable names for the seed rule. The decl's own attribute names read best
 *  (`Del_Open(p, t) :- Seed_Open(p, t).`), but they're documentation, not
 *  identifiers — fall back to positional names if they can't serve as vars. */
function seedVars(decl: RelDecl): string[] {
  const names = decl.attributes.map((a) => a.name)
  const usable =
    new Set(names).size === names.length && names.every((n) => /^_?[A-Za-z][A-Za-z0-9_]*$/.test(n))
  return usable ? names : decl.attributes.map((_, i) => `s${i}`)
}

function renderAtom(atom: Atom, subst?: ReadonlyMap<number, string>): string {
  const args = atom.args.map((a, i) => subst?.get(i) ?? atomArgToString(a))
  return `${atom.name}(${args.join(', ')})`
}

function varsOf(rhs: readonly Predicate[]): Set<string> {
  const out = new Set<string>()
  for (const p of rhs) {
    if (p.kind === 'Compare') continue
    for (const a of p.atom.args) if (a.kind === 'Var') out.add(a.name)
  }
  return out
}

/** Drop shadow rules whose body needs a shadow relation nothing produces —
 *  e.g. rules hanging off a view that couldn't be seeded. Iterated, because
 *  dropping a rule can remove the last producer of something else. */
function prune(rules: readonly ShadowRule[]): ShadowRule[] {
  let live = [...rules]
  for (;;) {
    const producers = new Set(live.map((r) => r.headRel))
    const next = live.filter((r) => r.needs.every((n) => producers.has(n)))
    if (next.length === live.length) return live
    live = next
  }
}

function attrsOf(decl: RelDecl): string {
  return decl.attributes
    .map((a) => `${a.name}: ${dataTypeToString(a.dataType)}`)
    .join(', ')
}

function render(
  program: Program,
  rules: readonly ShadowRule[],
  seeds: readonly string[],
  edbNames: ReadonlySet<string>,
  declOf: ReadonlyMap<string, RelDecl>,
): string {
  const lines: string[] = []

  lines.push('.in')
  for (const edb of program.edbs) {
    lines.push(`.decl ${edb.name}(${attrsOf(edb)})`)
    if (edb.path) lines.push(`.input ${edb.path}`)
  }
  // Seeds are fed by the caller, so they are EDBs of the shadow program.
  const seeded = new Set(seeds)
  for (const idb of program.idbs) {
    if (!seeded.has(idb.name)) continue
    lines.push(`.decl ${SEED_PREFIX}${idb.name}(${attrsOf(idb)})`)
  }

  lines.push('.printsize')
  for (const idb of program.idbs) {
    lines.push(`.decl ${idb.name}(${attrsOf(idb)})`)
    if (idb.path) lines.push(`.output ${idb.path}`)
  }
  // One decl per shadow relation actually derived. Attributes are copied from
  // the relation being shadowed where they exist; an untyped source stays
  // untyped and the arity is inferred from the shadow rules, as usual.
  for (const rel of new Set(rules.map((r) => r.headRel))) {
    const base = rel.slice(rel.indexOf('_') + 1)
    const decl = declOf.get(base)
    const attrs = decl && decl.attributes.length > 0 ? attrsOf(decl) : ''
    lines.push(`.decl ${rel}(${attrs})`)
  }
  // Every EDB is also a *destination*, so its Del_/Ins_ channels are IDBs of
  // the shadow program — nothing extra to declare beyond the loop above.
  void edbNames

  lines.push('.rule')
  for (const rule of program.rules) lines.push(rule.toString())
  for (const rule of rules) lines.push(rule.text)

  return `${lines.join('\n')}\n`
}
