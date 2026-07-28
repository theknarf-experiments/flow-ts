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

import { type InferredTypes, inferRelationTypes } from '../typing/index.js'
import { Attribute as AttributeCls, RelDecl as RelDeclCls } from '../ast/index.js'
import {
  type Atom,
  type FLRule,
  type HeadArg,
  type Predicate,
  type Program,
  type PutPolicy,
  type RelDecl,
  type Arithmetic,
  atomArgToString,
  constToString,
  factorToString,
  dataTypeToString,
  predicateToString,
  putPolicyToString,
} from '../ast/index.js'

export const SEED_PREFIX = 'Seed_'
export const SEED_UPD_PREFIX = 'SeedUpd_'
export const SEED_INS_PREFIX = 'SeedIns_'
export const DEL_PREFIX = 'Del_'
export const INS_PREFIX = 'Ins_'
export const UPD_PREFIX = 'Upd_'

/** A rule (or part of one) the compiler declined to invert. */
export interface ShadowRefusal {
  /** The offending rule as written, or a relation name for decl-level issues. */
  subject: string
  reason: string
}

export type ShadowChannel = 'del' | 'ins' | 'upd'

export interface ShadowOptions {
  /** Head relation → the policy for inverting it. Overrides a `.put` directive
   *  on the relation's declaration, so a caller can try a policy without
   *  editing the program. */
  put?: Record<string, PutPolicy>
  /** Which views can be written to. Omitted means all of them.
   *
   *  This is not free to leave open. A shadow rule replays its rule's body, so
   *  it forces joins — and therefore indexes — on relations the forward program
   *  never needed indexed that way. Measured on a flow-md-shaped program, that
   *  roughly doubles the cost of ordinary forward maintenance, which is paid
   *  continuously and by readers who never write. A vault with fifty views and
   *  one editable table should say so. */
  views?: readonly string[] | 'all'
  /** Which request channels to build. Omitted means all three. Deletion is the
   *  dearest, so a consumer that only rewrites cells can skip it. */
  channels?: readonly ShadowChannel[]
}

export interface ShadowProgram {
  /** The original program plus shadow decls and rules, as `.dl` source. */
  source: string
  /** Relations that gained a `Seed_` channel, i.e. views you can request
   *  changes to. */
  seeds: string[]
  /** Everything the compiler could not invert, and why. */
  refusals: ShadowRefusal[]
  /** Per view, the column indices an update can be written through.
   *
   *  This falls straight out of compilation — a column is listed exactly when
   *  an update rule was emitted for it — so it costs nothing extra and saves
   *  every consumer re-deriving the same analysis.
   *
   *  It is the *static* answer, and deliberately so: a UI has to decide which
   *  inputs are editable before it has a row in hand, and that question has no
   *  data in it. Whether a particular edit succeeds is a different question,
   *  and `resolveBackward` answers it exactly. A column listed here can still
   *  come back `ambiguous` or `unsatisfied` for a given row. For a head with
   *  several rules this is the union: a column one rule can rewrite is listed,
   *  because hiding it would deny the edit on rows that *can* take it. */
  writableColumns: Record<string, number[]>
}

interface ShadowRule {
  /** Shadow relation this rule derives, e.g. `Del_Task`. */
  headRel: string
  /** Shadow relations appearing in the body — the pruning dependency. */
  needs: string[]
  text: string
  /** The rule that takes a request off its seed. Kept even when nothing reads
   *  its channel: the view was opted into, so the request has to be *seedable*,
   *  and a channel that finds no candidates is a refusal to report rather than
   *  an unknown relation to crash on. */
  entry?: true
}

/** Compile the backward direction of `program` into shadow rules. */
export function compileShadow(
  program: Program,
  options: ShadowOptions = {},
): ShadowProgram {
  const refusals: ShadowRefusal[] = []
  const rules: ShadowRule[] = []
  const seeds: string[] = []
  // A `.put` directive on the declaration is the program's own statement of
  // intent; `options.put` lets a caller override it without editing the source.
  const policies: Record<string, PutPolicy> = {}
  for (const idb of program.idbs) if (idb.put) policies[idb.name] = idb.put
  Object.assign(policies, options.put ?? {})
  // Helper relations generated for aggregate inverses, declared alongside the
  // shadow relations. Kept separate because they are plain IDBs, not channels.
  const helpers: Array<{ name: string; attrs: string }> = []
  let helperSeq = 0
  // Head relation → head column indices for which an update rule was emitted.
  const writableCols = new Map<string, Set<number>>()
  const noteWritable = (rel: string, column: number): void => {
    let set = writableCols.get(rel)
    if (!set) writableCols.set(rel, (set = new Set()))
    set.add(column)
  }

  const edbNames = new Set(program.edbs.map((d) => d.name))
  // An untyped `.decl Foo()` leaves the arity to the rules, which is fine while
  // rows only flow out — but a Seed_ EDB needs a codec per column. Recovering
  // the types is what makes flow-md's `.decl Q<hash>()` queries seedable at all.
  const inferred = inferRelationTypes(program)
  const declOf = new Map<string, RelDecl>()
  for (const d of [...program.edbs, ...program.idbs]) {
    declOf.set(d.name, d.attributes.length > 0 ? d : withInferredAttrs(d, inferred))
  }

  // A request enters on a view, so every IDB gets a seed. It has to become an
  // EDB of the shadow program, which means real attributes: `.decl H()` (arity
  // inferred from the rules) carries nothing to build a fact channel from.
  const wantView = (name: string): boolean =>
    options.views === undefined || options.views === 'all' || options.views.includes(name)
  const wantChannel = (c: ShadowChannel): boolean =>
    !options.channels || options.channels.includes(c)

  for (const decl of program.idbs) {
    if (!wantView(decl.name)) continue
    const idb = declOf.get(decl.name)!
    if (idb.attributes.length === 0) {
      const why = inferred.unresolved.find((u) => u.rel === decl.name)?.reason
      refusals.push({
        subject: decl.name,
        reason:
          `"${decl.name}" has an untyped .decl and its column types could not be ` +
          `inferred, so no Seed_ EDB can be declared for it${why ? ` — ${why}` : ''}`,
      })
      continue
    }
    seeds.push(idb.name)
    const vars = seedVars(idb).join(', ')
    if (wantChannel('del')) {
      rules.push({
        headRel: DEL_PREFIX + idb.name,
        needs: [],
        entry: true,
        text: `${DEL_PREFIX}${idb.name}(${vars}) :- ${SEED_PREFIX}${idb.name}(${vars}).`,
      })
    }
    // The update channel carries the old tuple followed by its replacement, so
    // its arity is 2n and the seed's decl needs two sets of attribute names.
    const pair = updVars(idb).join(', ')
    if (wantChannel('upd')) {
      rules.push({
        headRel: UPD_PREFIX + idb.name,
        needs: [],
        entry: true,
        text: `${UPD_PREFIX}${idb.name}(${pair}) :- ${SEED_UPD_PREFIX}${idb.name}(${pair}).`,
      })
    }
    if (wantChannel('ins')) {
      rules.push({
        headRel: INS_PREFIX + idb.name,
        needs: [],
        entry: true,
        text: `${INS_PREFIX}${idb.name}(${vars}) :- ${SEED_INS_PREFIX}${idb.name}(${vars}).`,
      })
    }
  }

  const ruleCountByHead = new Map<string, number>()
  for (const rule of program.rules) {
    ruleCountByHead.set(rule.head.name, (ruleCountByHead.get(rule.head.name) ?? 0) + 1)
  }

  // How many of a head's rules mention the relation an `insert via` names. One
  // is a choice; zero or several is not a choice at all, and says so.
  const insertViaRuleCount = new Map<string, number>()
  for (const rule of program.rules) {
    const p = policies[rule.head.name]
    if (p?.kind !== 'insert' || !p.via) continue
    const via = p.via
    const mentions = rule.rhs.some((x) => x.kind !== 'Compare' && x.atom.name === via)
    if (mentions) {
      insertViaRuleCount.set(rule.head.name, (insertViaRuleCount.get(rule.head.name) ?? 0) + 1)
    }
  }

  for (const rule of program.rules) {
    const subject = rule.toString()

    // The head has to be invertible into an atom: plain variables (and bare
    // constants) only. Arithmetic and aggregation are where the forward
    // direction stops being a copy, and they need annotation, not inference.
    const policy = policies[rule.head.name]
    if (policy?.kind === 'none') continue

    // `into R` restricts which body atoms are candidates. R is still replayed
    // in every body — it is held constant, not ignored — but nothing proposes a
    // change to it.
    let only: string | null = null
    if (policy?.kind === 'into') {
      const mentioned = rule.rhs.some((p) => p.kind !== 'Compare' && p.atom.name === policy.rel)
      if (!mentioned) {
        refusals.push({
          subject,
          reason: `"${rule.head.name}" declares .put into ${policy.rel}, but no atom of this rule's body is ${policy.rel}`,
        })
        continue
      }
      only = policy.rel
    }

    if (policy?.kind === 'spread') {
      const emitted = compileSpread(
        rule,
        policy,
        declOf,
        () => `Sh${helperSeq++}`,
        helpers,
        rules,
      )
      if (emitted) {
        // `spread` inverts the aggregate column, which is the last one.
        noteWritable(rule.head.name, rule.head.headArguments.length - 1)
        continue
      }
      refusals.push({
        subject,
        reason: `"${rule.head.name}" has a spread policy but its head is not an aggregate over a single member column`,
      })
      continue
    }

    const taken = varsOf(rule.rhs)
    let fresh = 0
    const nextVar = (): string => {
      let name = `_v${fresh++}`
      while (taken.has(name)) name = `_v${fresh++}`
      taken.add(name)
      return name
    }

    // A computed head position has no variable to name it, so bind one and
    // replay the computation as a filter. That is all deletion ever needed —
    // it only asks which source tuple produced the row. Refusing the whole rule
    // for a computed column, as this used to, also refused the deletions that
    // never depended on inverting anything.
    const headArgs: string[] = []
    const headFilters: string[] = []
    let headOk = true
    for (const ha of rule.head.headArguments) {
      const rendered = headArgAsAtomArg(ha)
      if (rendered !== null) {
        headArgs.push(rendered)
        continue
      }
      if (ha.kind !== 'Arith') {
        refusals.push({ subject, reason: refusalFor(ha) })
        headOk = false
        break
      }
      const bound = nextVar()
      headArgs.push(bound)
      headFilters.push(`${bound} == ${ha.arithmetic.toString()}`)
    }
    if (!headOk) continue

    const request = `${rule.head.name}(${headArgs.join(', ')})`

    // --- insert channel --------------------------------------------------
    //
    // The mirror of deletion, and the asymmetry is the point. Killing a
    // disjunction kills every disjunct, so a delete fans out over *rules* and
    // picks one atom within each. Satisfying a disjunction needs only one
    // disjunct, so an insert picks one *rule* and fans out over its whole body,
    // because a conjunction needs all of it. Deletion's ambiguity is which atom;
    // insertion's is which rule, and only the second is unavoidable.
    emitInsertRules(
      rule,
      headArgs,
      ruleCountByHead.get(rule.head.name) ?? 1,
      only,
      policy?.kind === 'insert' ? policy : null,
      insertViaRuleCount,
      rules,
      refusals,
    )

    // --- update channel ------------------------------------------------
    //
    // For each head column, if its variable occurs at exactly one position of
    // exactly one body atom, an edit to that column rewrites that position.
    // The request atom repeats the *unchanged* head variables, so the rule
    // matches "this column moved and the others didn't" structurally.
    //
    // More than one occurrence means the value is joined on, and rewriting it
    // would have to change every occurrence at once — the join ambiguity,
    // which is a policy rather than an inference. Skipped for now.
    rule.head.headArguments.forEach((ha, k) => {
      // A computed column needs its arithmetic undone before the source
      // position can be rewritten. Only some of it can be: `+`, `-` and `*`
      // invert, `/` and `%` are not injective, and a multi-step expression
      // would need helper relations because arithmetic here is flat.
      if (ha.kind === 'Arith') {
        if (
          emitComputedUpdate(rule, ha.arithmetic, headArgs, k, headFilters, only, rules, refusals)
        ) {
          noteWritable(rule.head.name, k)
        }
        return
      }
      if (ha.kind !== 'Var') return
      const sites = occurrencesOf(ha.name, rule.rhs)
      if (sites.length !== 1) return
      const [site] = sites
      const { atomIndex, argIndex } = site!
      const pred = rule.rhs[atomIndex]!
      if (pred.kind !== 'Atom') return
      const atom = pred.atom
      if (only !== null && atom.name !== only) return

      const fresh = freshName(`${ha.name}_n`, taken)
      const request = headArgs.map((a, j) => (j === k ? [a, fresh] : [a, a]))
      // Placeholders can't be projected into the shadow head, and the rewrite
      // has to carry them through unchanged — so name them, here and in the
      // replayed body, exactly as the delete channel does.
      const subst = new Map<number, string>()
      atom.args.forEach((a, j) => {
        if (a.kind === 'Placeholder') subst.set(j, nextVar())
      })
      const before = atom.args.map((a, j) => subst.get(j) ?? atomArgToString(a))
      const after = before.map((a, j) => (j === argIndex ? fresh : a))
      const body = [
        ...rule.rhs.map((p, j) => (j === atomIndex ? renderAtom(atom, subst) : predicateToString(p))),
        ...headFilters,
      ].join(', ')

      noteWritable(rule.head.name, k)
      rules.push({
        headRel: UPD_PREFIX + atom.name,
        needs: [UPD_PREFIX + rule.head.name],
        text:
          `${UPD_PREFIX}${atom.name}(${[...before, ...after].join(', ')}) :- ` +
          `${UPD_PREFIX}${rule.head.name}(${[
            ...request.map((r) => r[0]),
            ...request.map((r) => r[1]),
          ].join(', ')}), ${body}.`,
      })
    })

    rule.rhs.forEach((pred, i) => {
      if (pred.kind === 'Compare') return
      const atom = pred.atom

      if (pred.kind === 'Atom') {
        if (only !== null && atom.name !== only) return
        // Placeholders carry no name, so they can't be projected into the
        // shadow head — give them one. Only in *this* atom's occurrence: the
        // rest of the body is replayed as written.
        const subst = new Map<number, string>()
        atom.args.forEach((a, j) => {
          if (a.kind === 'Placeholder') subst.set(j, nextVar())
        })
        const body = [
          ...rule.rhs.map((p, j) => (j === i ? renderAtom(atom, subst) : predicateToString(p))),
          ...headFilters,
        ].join(', ')
        rules.push({
          headRel: DEL_PREFIX + atom.name,
          needs: [DEL_PREFIX + rule.head.name],
          text: `${DEL_PREFIX}${renderAtom(atom, subst)} :- ${DEL_PREFIX}${request}, ${body}.`,
        })
        return
      }

      if (only !== null && atom.name !== only) return
      // Negated atom: the polarity flips. Un-deriving the head can be achieved
      // by making the negation fail — i.e. inserting the tuple it excludes.
      if (atom.args.some((a) => a.kind === 'Placeholder')) {
        refusals.push({
          subject,
          reason: `negated atom ${atom.toString()} has a placeholder, so the tuple to insert is underdetermined`,
        })
        return
      }
      const body = [...rule.rhs.map((p) => predicateToString(p)), ...headFilters].join(', ')
      rules.push({
        headRel: INS_PREFIX + atom.name,
        needs: [DEL_PREFIX + rule.head.name],
        text: `${INS_PREFIX}${renderAtom(atom)} :- ${DEL_PREFIX}${request}, ${body}.`,
      })
    })
  }

  const live = prune(rules, edbNames)
  const liveHeads = new Set(live.map((r) => r.headRel))
  // Only report a column whose update channel actually survived: a view that
  // was scoped out, or whose Upd_ channel was switched off, is not writable
  // however invertible its rules happen to be.
  const writableColumns: Record<string, number[]> = {}
  for (const [rel, set] of writableCols) {
    if (!liveHeads.has(UPD_PREFIX + rel)) continue
    writableColumns[rel] = [...set].sort((a, b) => a - b)
  }
  return {
    writableColumns,
    source: render(
      program,
      live,
      seeds,
      declOf,
      helpers.filter((h) => liveHeads.has(h.name)),
    ),
    seeds,
    refusals,
  }
}

/** Update rules for a head column that is computed rather than copied.
 *
 *  The forward direction is `y = f(x)`; the backward one needs `x = f⁻¹(y)`,
 *  and that only exists for some `f`. Addition, subtraction and multiplication
 *  invert; division truncates and modulo collapses, so many inputs share an
 *  output and there is no principled choice of which to write back. Flat
 *  left-to-right arithmetic means a multi-step expression would need helper
 *  relations to undo one operation at a time, so it is refused for now rather
 *  than half-supported.
 *
 *  Multiplication is exact only when the request divides evenly. It isn't
 *  refused for that, because the verify step is what the protocol has instead
 *  of trusting a proposal — an indivisible request comes back `unsatisfied`. */
function emitComputedUpdate(
  rule: FLRule,
  arith: Arithmetic,
  headArgs: readonly string[],
  k: number,
  headFilters: readonly string[],
  only: string | null,
  out: ShadowRule[],
  refusals: ShadowRefusal[],
): boolean {
  const subject = rule.toString()
  const vars = arith.vars()
  if (vars.length === 0) return false // a bare constant: nothing to write back to
  if (new Set(vars).size > 1 || vars.length > 1) {
    refusals.push({
      subject,
      reason:
        `the computed column of "${rule.head.name}" depends on more than one variable ` +
        `(${[...new Set(vars)].join(', ')}), so a new value does not determine a new input`,
    })
    return false
  }
  if (arith.rest.length !== 1) {
    refusals.push({
      subject,
      reason:
        `the computed column of "${rule.head.name}" is not a single operation, and flat ` +
        'arithmetic cannot express its inverse without helper relations',
    })
    return false
  }

  const v = vars[0]!
  const [op, operand] = arith.rest[0]!
  const varIsInit = arith.init.kind === 'Var'
  const other = varIsInit ? factorToString(operand) : factorToString(arith.init)
  if (!varIsInit && operand.kind !== 'Var') return false

  // `y = x op c` undoes as `x = y op⁻¹ c`; `y = c op x` needs the operation
  // rearranged instead, which only works when it can be.
  let inverse: string | null = null
  if (varIsInit) {
    if (op === 'Plus') inverse = `%s - ${other}`
    else if (op === 'Minus') inverse = `%s + ${other}`
    else if (op === 'Multiply') inverse = `%s / ${other}`
  } else {
    if (op === 'Plus') inverse = `%s - ${other}`
    else if (op === 'Minus') inverse = `${other} - %s`
    else if (op === 'Multiply') inverse = `%s / ${other}`
  }
  if (!inverse) {
    refusals.push({
      subject,
      reason:
        `the computed column of "${rule.head.name}" uses ${op}, which is not injective — ` +
        'many inputs give the same output, so nothing says which to write back',
    })
    return false
  }

  const sites = occurrencesOf(v, rule.rhs)
  if (sites.length !== 1) return false
  const { atomIndex, argIndex } = sites[0]!
  const pred = rule.rhs[atomIndex]!
  if (pred.kind !== 'Atom') return false
  const atom = pred.atom
  if (only !== null && atom.name !== only) return false

  const fresh = `${headArgs[k]}_n`
  const request = headArgs.map((a, j) => (j === k ? [a, fresh] : [a, a]))
  const before = atom.args.map(atomArgToString)
  const after = before.map((a, j) => (j === argIndex ? inverse.replace('%s', fresh) : a))
  const body = [...rule.rhs.map((p) => predicateToString(p)), ...headFilters].join(', ')

  out.push({
    headRel: UPD_PREFIX + atom.name,
    needs: [UPD_PREFIX + rule.head.name],
    text:
      `${UPD_PREFIX}${atom.name}(${[...before, ...after].join(', ')}) :- ` +
      `${UPD_PREFIX}${rule.head.name}(${[
        ...request.map((r) => r[0]),
        ...request.map((r) => r[1]),
      ].join(', ')}), ${body}.`,
  })
  return true
}

/** Insert rules for one forward rule: what has to become true for its head to
 *  hold. Every body atom is required (a conjunction), and a negated atom flips
 *  to a retraction.
 *
 *  Two things stop it, and both are refusals with a reason rather than a guess:
 *  a head defined by several rules, where satisfying one is a choice nothing in
 *  the program makes; and a body variable the head doesn't carry, where there
 *  is simply no value to insert. Comparisons are replayed, so a request that
 *  violates a filter proposes nothing instead of proposing something doomed. */
function emitInsertRules(
  rule: FLRule,
  headArgs: readonly string[],
  ruleCount: number,
  only: string | null,
  insertPolicy: Extract<PutPolicy, { kind: 'insert' }> | null,
  insertViaRuleCount: ReadonlyMap<string, number>,
  out: ShadowRule[],
  refusals: ShadowRefusal[],
): void {
  const subject = rule.toString()
  const headVars = new Set(
    rule.head.headArguments.flatMap((ha) => (ha.kind === 'Var' ? [ha.name] : [])),
  )

  const insertVia = insertPolicy?.via ?? null
  const defaults = new Map(insertPolicy?.defaults ?? [])

  if (insertVia !== null) {
    const matches = insertViaRuleCount.get(rule.head.name) ?? 0
    if (matches === 0) {
      refusals.push({
        subject,
        reason: `"${rule.head.name}" declares .put insert via ${insertVia}, but no rule for it mentions ${insertVia}`,
      })
      return
    }
    if (matches > 1) {
      refusals.push({
        subject,
        reason:
          `"${rule.head.name}" declares .put insert via ${insertVia}, but several rules mention ` +
          `${insertVia}, so it still doesn't say which one to satisfy`,
      })
      return
    }
    // Only the rule that mentions it contributes; the others are alternatives
    // this annotation has declined.
    if (!rule.rhs.some((p) => p.kind !== 'Compare' && p.atom.name === insertVia)) return
  } else if (ruleCount > 1) {
    refusals.push({
      subject,
      reason:
        `"${rule.head.name}" is defined by several rules, so inserting a row means choosing ` +
        'which rule to satisfy — annotate with `.put insert via <relation>` to say which',
    })
    return
  }

  for (const p of rule.rhs) {
    if (p.kind === 'Compare') continue
    for (const arg of p.atom.args) {
      if (arg.kind === 'Const') continue
      if (arg.kind === 'Placeholder') {
        refusals.push({
          subject,
          reason: `inserting into "${rule.head.name}" would need a value for a placeholder in ${p.atom.name}`,
        })
        return
      }
      if (!headVars.has(arg.name) && !defaults.has(arg.name)) {
        refusals.push({
          subject,
          reason:
            `inserting into "${rule.head.name}" would need a value for "${arg.name}", which ` +
            `appears in ${p.atom.name} but not in the head — supply one with ` +
            '`.put insert defaults(...)`',
        })
        return
      }
    }
  }

  const request = `${INS_PREFIX}${rule.head.name}(${headArgs.join(', ')})`
  const filters = rule.rhs
    .filter((p) => p.kind === 'Compare')
    .map((p) => predicateToString(p))
  const body = [request, ...filters].join(', ')

  for (const p of rule.rhs) {
    if (p.kind === 'Compare') continue
    if (only !== null && p.atom.name !== only) continue
    const prefix = p.kind === 'Atom' ? INS_PREFIX : DEL_PREFIX
    // A variable the head doesn't carry takes its declared default. The value
    // is a constant in the generated rule, so it needs no channel of its own.
    const subst = new Map<number, string>()
    p.atom.args.forEach((arg, i) => {
      if (arg.kind !== 'Var') return
      const d = defaults.get(arg.name)
      if (d) subst.set(i, constToString(d))
    })
    out.push({
      headRel: prefix + p.atom.name,
      needs: [INS_PREFIX + rule.head.name],
      text: `${prefix}${renderAtom(p.atom, subst)} :- ${body}.`,
    })
  }
}

/** Invert a linear aggregate by least change plus a named residual.
 *
 *  For `Total(p, sum(h)) :- Hours(p, w, h).` this generates, with `Sh<N>` a
 *  fresh prefix per rule:
 *
 *    Sh0(p, count(w))      :- Hours(p, w, h).          -- group size
 *    Sh1(p, s2 - s)        :- Upd_Total(p, s, p, s2).  -- requested delta
 *    Sh2(p, d / n)         :- Sh1(p, d), Sh0(p, n).    -- share (truncating)
 *    Sh3(p, q * n)         :- Sh2(p, q), Sh0(p, n).
 *    Sh4(p, d - m)         :- Sh1(p, d), Sh3(p, m).    -- residual
 *    Sh5(p, min(w))        :- Hours(p, w, h).          -- who absorbs it
 *    Upd_Hours(p, w, h, p, w, h + q)     :- …, w != a.
 *    Upd_Hours(p, w, h, p, w, h + q + r) :- …, Sh5(p, w).
 *
 *  One operation per rule because arithmetic is flat and left-to-right, and a
 *  computed value has to sit in the head — see
 *  tests/executing/comparisons.test.ts.
 *
 *  Returns false when the rule isn't a shape this can invert: the head must be
 *  group-by variables plus one aggregate over a body variable, and the atom
 *  supplying it must have exactly one remaining column to identify members by
 *  (otherwise "the lowest member" doesn't name a unique tuple). */
function compileSpread(
  rule: FLRule,
  policy: Extract<PutPolicy, { kind: 'spread' }>,
  declOf: ReadonlyMap<string, RelDecl>,
  freshHelper: () => string,
  helpers: Array<{ name: string; attrs: string }>,
  out: ShadowRule[],
): boolean {
  // Head must be: plain group-by variables, then exactly one aggregate.
  const groupBy: string[] = []
  let agg: { op: string; variable: string } | null = null
  for (const ha of rule.head.headArguments) {
    if (ha.kind === 'Var') {
      if (agg) return false // group-by column after the aggregate
      groupBy.push(ha.name)
      continue
    }
    if (ha.kind !== 'Aggregation' || agg) return false
    const vars = ha.aggregation.vars()
    if (vars.length !== 1) return false
    agg = { op: ha.aggregation.operator, variable: vars[0]! }
  }
  if (!agg || agg.op !== 'Sum') return false

  // The single positive atom supplying the aggregated variable.
  const atoms = rule.rhs.filter((p) => p.kind === 'Atom')
  if (atoms.length !== 1) return false
  const pred = atoms[0]!
  if (pred.kind !== 'Atom') return false
  const atom = pred.atom
  const args = atom.args.map(atomArgToString)
  if (!atom.args.every((a) => a.kind === 'Var')) return false
  if (!args.includes(agg.variable)) return false

  // Members are identified by whatever column is neither grouped nor summed.
  const memberCols = args.filter((a) => a !== agg.variable && !groupBy.includes(a))
  if (memberCols.length !== 1) return false
  const member = memberCols[0]!

  const decl = declOf.get(atom.name)
  if (!decl || decl.attributes.length !== args.length) return false

  const g = groupBy.join(', ')
  const gAttrs = groupBy
    .map((v) => {
      const i = args.indexOf(v)
      return `${v}: ${dataTypeToString(decl.attributes[i]!.dataType)}`
    })
    .join(', ')
  const memberType = dataTypeToString(decl.attributes[args.indexOf(member)]!.dataType)
  const num = 'number'

  const size = freshHelper()
  const delta = freshHelper()
  const share = freshHelper()
  const prod = freshHelper()
  const rem = freshHelper()
  const absorb = freshHelper()

  helpers.push(
    { name: size, attrs: `${gAttrs}, n: ${num}` },
    { name: delta, attrs: `${gAttrs}, d: ${num}` },
    { name: share, attrs: `${gAttrs}, q: ${num}` },
    { name: prod, attrs: `${gAttrs}, m: ${num}` },
    { name: rem, attrs: `${gAttrs}, r: ${num}` },
    { name: absorb, attrs: `${gAttrs}, a: ${memberType}` },
  )

  const body = renderAtom(atom)
  const req = `${UPD_PREFIX}${rule.head.name}(${g}, s, ${g}, s2)`
  const need = [UPD_PREFIX + rule.head.name]

  out.push(
    { headRel: size, needs: [], text: `${size}(${g}, count(${member})) :- ${body}.` },
    { headRel: delta, needs: need, text: `${delta}(${g}, s2 - s) :- ${req}.` },
    {
      headRel: share,
      needs: [delta, size],
      text: `${share}(${g}, d / n) :- ${delta}(${g}, d), ${size}(${g}, n).`,
    },
    {
      headRel: prod,
      needs: [share, size],
      text: `${prod}(${g}, q * n) :- ${share}(${g}, q), ${size}(${g}, n).`,
    },
    {
      headRel: rem,
      needs: [delta, prod],
      text: `${rem}(${g}, d - m) :- ${delta}(${g}, d), ${prod}(${g}, m).`,
    },
    {
      headRel: absorb,
      needs: [],
      text: `${absorb}(${g}, ${policy.residual === 'min' ? 'min' : 'max'}(${member})) :- ${body}.`,
    },
    {
      headRel: UPD_PREFIX + atom.name,
      needs: [share, absorb],
      text:
        `${UPD_PREFIX}${atom.name}(${args.join(', ')}, ${args
          .map((a) => (a === agg.variable ? `${a} + q` : a))
          .join(', ')}) :- ${body}, ${share}(${g}, q), ${absorb}(${g}, a), ${member} != a.`,
    },
    {
      headRel: UPD_PREFIX + atom.name,
      needs: [share, rem, absorb],
      text:
        `${UPD_PREFIX}${atom.name}(${args.join(', ')}, ${args
          .map((a) => (a === agg.variable ? `${a} + q + r` : a))
          .join(', ')}) :- ${body}, ${share}(${g}, q), ${rem}(${g}, r), ${absorb}(${g}, ${member}).`,
    },
  )
  return true
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
/** A declaration with inferred attributes filled in, when the source left them
 *  out and inference could recover them. Names are positional: the point is the
 *  types, and invented names would read as if the author had written them. */
function withInferredAttrs(decl: RelDecl, inferred: InferredTypes): RelDecl {
  const cols = inferred.types.get(decl.name)
  if (!cols || cols.length === 0) return decl
  return new RelDeclCls(
    decl.name,
    cols.map((t, i) => new AttributeCls(`c${i}`, t)),
    decl.path,
    decl.put,
  )
}

function seedVars(decl: RelDecl): string[] {
  const names = decl.attributes.map((a) => a.name)
  const usable =
    new Set(names).size === names.length && names.every((n) => /^_?[A-Za-z][A-Za-z0-9_]*$/.test(n))
  return usable ? names : decl.attributes.map((_, i) => `s${i}`)
}

/** Variables for the update channel's 2n columns: old tuple, then new. Always
 *  positional — the two halves would otherwise collide with each other. */
function updVars(decl: RelDecl): string[] {
  return [
    ...decl.attributes.map((_, i) => `a${i}`),
    ...decl.attributes.map((_, i) => `b${i}`),
  ]
}

/** Every (atom, argument) position where `name` occurs in the body, counting
 *  comparisons too — a variable a filter reads is one the rewrite would also
 *  have to satisfy, so it isn't a free copy. */
function occurrencesOf(
  name: string,
  rhs: readonly Predicate[],
): Array<{ atomIndex: number; argIndex: number }> {
  const out: Array<{ atomIndex: number; argIndex: number }> = []
  rhs.forEach((p, atomIndex) => {
    if (p.kind === 'Compare') {
      if (p.expr.varsSet().has(name)) out.push({ atomIndex, argIndex: -1 })
      return
    }
    p.atom.args.forEach((a, argIndex) => {
      if (a.kind === 'Var' && a.name === name) out.push({ atomIndex, argIndex })
    })
  })
  return out
}

function freshName(base: string, taken: Set<string>): string {
  let name = base
  let n = 0
  while (taken.has(name)) name = `${base}${n++}`
  taken.add(name)
  return name
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
/** Drop rules that cannot fire and rules nothing reads, to a fixpoint.
 *
 *  Forwards is the obvious half: a rule whose channel was never seeded can
 *  never fire. Backwards is the half that was missing, and `views: []` is what
 *  exposed it — the aggregate helpers `spread` generates read only EDBs, so
 *  they need nothing, so the forward pass kept them however thoroughly the
 *  view they belonged to had been scoped out. Two rules is not much; a claim of
 *  "nothing is compiled unless you ask" that quietly isn't true is worse than
 *  the two rules.
 *
 *  The roots for the backward pass are the channels on *source* relations,
 *  because those are the answer — a `Del_MdTask` is read by nobody here and is
 *  the whole point. Everything else earns its place by being needed. */
function prune(rules: readonly ShadowRule[], edbNames: ReadonlySet<string>): ShadowRule[] {
  const isAnswer = (headRel: string): boolean => {
    const at = headRel.indexOf('_')
    return at > 0 && edbNames.has(headRel.slice(at + 1))
  }

  let live = [...rules]
  for (;;) {
    const producers = new Set(live.map((r) => r.headRel))
    let next = live.filter((r) => r.needs.every((n) => producers.has(n)))

    const wanted = new Set<string>()
    for (const r of next) if (r.entry || isAnswer(r.headRel)) wanted.add(r.headRel)
    for (;;) {
      const before = wanted.size
      for (const r of next) {
        if (!wanted.has(r.headRel)) continue
        for (const n of r.needs) wanted.add(n)
      }
      if (wanted.size === before) break
    }
    next = next.filter((r) => wanted.has(r.headRel))

    if (next.length === live.length) return live
    live = next
  }
}

function attrsOf(decl: RelDecl): string {
  return decl.attributes
    .map((a) => `${a.name}: ${dataTypeToString(a.dataType)}`)
    .join(', ')
}

/** Attributes for an update channel: the relation's columns twice over, named
 *  positionally so the two halves can't collide. */
function pairAttrsOf(decl: RelDecl): string {
  return [
    ...decl.attributes.map((a, i) => `a${i}: ${dataTypeToString(a.dataType)}`),
    ...decl.attributes.map((a, i) => `b${i}: ${dataTypeToString(a.dataType)}`),
  ].join(', ')
}

function render(
  program: Program,
  rules: readonly ShadowRule[],
  seeds: readonly string[],
  declOf: ReadonlyMap<string, RelDecl>,
  helpers: ReadonlyArray<{ name: string; attrs: string }>,
): string {
  const lines: string[] = []
  // Seed EDBs are only declared when a surviving rule actually reads them; a
  // channel that was switched off, or pruned away, leaves no decl behind.
  const channelsUsed = new Set<string>()
  for (const r of rules) {
    for (const m of r.text.matchAll(/\b(Seed_|SeedUpd_|SeedIns_)(\w+)\(/g)) {
      channelsUsed.add(`${m[1]}${m[2]}`)
    }
  }

  lines.push('.in')
  for (const edb of program.edbs) {
    lines.push(`.decl ${edb.name}(${attrsOf(edb)})`)
    if (edb.path) lines.push(`.input ${edb.path}`)
  }
  // Seeds are fed by the caller, so they are EDBs of the shadow program.
  const seeded = new Set(seeds)
  for (const decl of program.idbs) {
    if (!seeded.has(decl.name)) continue
    // The resolved declaration, so an inferred view gets a typed fact channel.
    const idb = declOf.get(decl.name) ?? decl
    if (channelsUsed.has(`${SEED_PREFIX}${idb.name}`)) {
      lines.push(`.decl ${SEED_PREFIX}${idb.name}(${attrsOf(idb)})`)
    }
    if (channelsUsed.has(`${SEED_UPD_PREFIX}${idb.name}`)) {
      lines.push(`.decl ${SEED_UPD_PREFIX}${idb.name}(${pairAttrsOf(idb)})`)
    }
    if (channelsUsed.has(`${SEED_INS_PREFIX}${idb.name}`)) {
      lines.push(`.decl ${SEED_INS_PREFIX}${idb.name}(${attrsOf(idb)})`)
    }
  }

  lines.push('.printsize')
  for (const decl of program.idbs) {
    // Emit the *resolved* declaration: the shadow program's rules reference
    // these relations by arity, and an untyped decl would leave the seeded
    // channels without a shape to match.
    const idb = declOf.get(decl.name) ?? decl
    lines.push(`.decl ${idb.name}(${attrsOf(idb)})`)
    if (idb.path) lines.push(`.output ${idb.path}`)
    // Preserve the directive. The shadow source is only ever read back, never
    // recompiled, so it is inert here — but silently dropping it would make the
    // generated program an unfaithful rendering of the one it came from.
    if (idb.put) lines.push(putPolicyToString(idb.put))
  }
  // One decl per shadow relation actually derived. Attributes are copied from
  // the relation being shadowed where they exist; an untyped source stays
  // untyped and the arity is inferred from the shadow rules, as usual.
  for (const h of helpers) lines.push(`.decl ${h.name}(${h.attrs})`)
  const helperNames = new Set(helpers.map((h) => h.name))
  for (const rel of new Set(rules.map((r) => r.headRel))) {
    if (helperNames.has(rel)) continue
    const base = rel.slice(rel.indexOf('_') + 1)
    const decl = declOf.get(base)
    const typed = decl && decl.attributes.length > 0
    const attrs = typed
      ? rel.startsWith(UPD_PREFIX)
        ? pairAttrsOf(decl)
        : attrsOf(decl)
      : ''
    lines.push(`.decl ${rel}(${attrs})`)
  }
  lines.push('.rule')
  for (const rule of program.rules) lines.push(rule.toString())
  for (const rule of rules) lines.push(rule.text)

  return `${lines.join('\n')}\n`
}
