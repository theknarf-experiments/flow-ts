# Backward propagation: shadow rules

> Status: working prototype, `packages/flow-ts/src/shadow/`. Supersedes the
> where-provenance proposal drafted in the flow-page repo, which took a
> different (and, on the evidence here, worse) approach.

## The problem

flow-md and flow-page both let you edit a query result and have the change land
in the source file. Both need the same inversion: given a row of a derived
relation, which EDB tuples produced it? Both solve it *outside* the engine —
flow-md by unfolding rules and searching for witnesses (`server/src/lineage.ts`,
433 lines), flow-page by keeping `(path, id)` in every result row so no
inversion is needed at all.

The earlier proposal was to give the engine per-cell **where-provenance**:
thread a `CellOrigin{file, fact, col}` through every operator, excluded from
keying. That fights the engine — flow-ts's atom is a tuple in a Z-set, not a
cell — and it needs stable source identities, which the proposal itself called
"the crux" and "not just an engine change".

## The approach

Take the delta form instead. The engine already computes `ΔE → ΔI` forward; what
is missing is `ΔI → ΔE`. And that direction is itself a conjunctive query, so it
can be written as **more Datalog**: take the original body, join the request
onto it, project onto one body atom.

```datalog
Open(p, t)                :- Task(p, "open", t, l).
Del_Task(p, "open", t, l) :- Del_Open(p, t), Task(p, "open", t, l).
```

Replaying the body is what recovers `l`, the column the view projected away.
That one line replaces the whole of `lineage.ts`'s witness search.

Three consequences fall out:

- **Shadow relations are ordinary IDBs**, so a request walks back through the
  entire rule graph by itself — `Del_Top` derives `Del_Mid` derives `Del_Base` —
  incrementally, like everything else.
- **Recursion works.** The shadow of a recursive rule is recursive; its fixpoint
  is the support set. Recursion isn't uninvertible, it's *maximally ambiguous*.
- **Nothing positional enters the dataflow.** The answer is a value-level EDB
  delta, which is exactly what `plugin.updateFact(content, oldFact, newFact)`
  consumes. The stable-identity prerequisite disappears; spans stay a write-time
  reparse inside the plugin.

### Channels

`Del_R` retracts, `Ins_R` inserts, `Upd_R` rewrites (arity 2n: old tuple then
new). Requests enter on `Seed_R` / `SeedUpd_R`, kept separate because `Del_R` is
*derived* by the shadow rules of R's consumers, and a relation is either fed
with facts or computed from them.

Negation swaps Del and Ins: one way to un-derive `Visible(x) :- Item(x),
!Hidden(x)` is to drop the Item, the other is to add the Hidden.

### The polarity algebra

| construct | `Del_H` | `Ins_H` |
|---|---|---|
| positive body atom `Bᵢ` | `Del_Bᵢ`, one candidate per atom | `Ins_Bᵢ` for all atoms (conjunction) |
| negated body atom `!Bⱼ` | `Ins_Bⱼ` — flips | `Del_Bⱼ` — flips |
| multi-rule head | fires for every rule (all derivations must die) | needs one — a choice |
| existential in `Bᵢ` | bound by replay — free | unbound — needs a template |

Deletion through a multi-rule head is therefore mechanical, because killing a
disjunction means killing every disjunct. flow-md refuses multi-rule heads
outright; half of that refusal is unnecessary.

For updates, a rule is emitted per head column whose variable occurs at exactly
one body position. The request atom repeats the *unchanged* head variables, so
"column 1 moved and column 0 didn't" is matched structurally:

```datalog
Upd_Task(p, "open", t, l, p, "open", t_n, l)
  :- Upd_Open(p, t, p, t_n), Task(p, "open", t, l).
```

## Ambiguity becomes data

`lineage.ts` computes writability *statically* and conservatively, then may still
fail at resolve time. With shadow tables the candidate set is a relation, so
ambiguity is a query over it — data-dependent and exact. A join column that
lineage refuses categorically is writable whenever the other side happens to
have a unique match, which in a vault is most of the time.

## What needs annotation

Everything above is forced by the rule. Two things are not, and they get `.put`
on the relation's declaration:

```datalog
.printsize
.decl Total(p: string, s: number)
.put spread(min)
```

- **`spread(min|max)`** — inverting a linear aggregate. See below; the residual
  owner is a genuine free choice.
- **`.put into R`** — which side of a join a write lands on. Bancilhon &
  Spyratos' constant complement named directly: the other atoms are still
  replayed, so they constrain which tuples qualify, but nothing proposes a
  change to them. Turns `ambiguous` into `ok` for the request that reaches both
  sides, and a request reaching *only* the held side into `refused`.
- **`.put none`** — read-only on purpose, so a refusal reads as a decision
  rather than an omission.

Still refused, not yet annotatable: head arithmetic, the insert branch of a
multi-rule head, insert templates for existentials, and a minimal cut under
recursion.

## Findings that changed the design

**The aggregate claim was wrong as stated.** I argued linear aggregates need no
annotation, because least change is *determined*: minimising Σδᵢ² subject to
Σδᵢ = Δ gives δᵢ = Δ/n uniquely, which is what bireactive's `mean` and `mix`
compute. That holds over the reals. flow-ts's `Divide` is `Math.trunc(acc / x)`
— there is no true division in the language, and a float column doesn't change
it. So equal split silently under-delivers whenever `n ∤ Δ`, and integer least
change is genuinely ambiguous: `⌊Δ/n⌋` to everyone plus one extra unit to
`Δ mod n` of them, every choice of *which* equally minimal. Hence exactly one
knob, and it is unavoidable.

**`put` is sound but not complete, in two ways that no static analysis catches.**
Both were found by fuzzing:

- *Negation.* The fact supporting a row can be the same fact blocking a second
  derivation of it, so retracting the candidate brings the row straight back.
  `I0(a) :- E0(a, d, b), !E0(a, a, d).` with `E0 = {(0,0,1), (0,1,1)}`.
- *Aliasing.* One tuple can satisfy two body atoms, so rewriting it for one
  destroys the other's witness. `I0(d, a) :- E0(d, 1), E0(d, a).` with
  `E0 = {(1,1)}`.

Whether either happens depends on the data. So the compiler is the wrong place
to fix it.

**Hence the runtime protocol.** `resolveBackward` runs the forward program on the
proposed facts and compares: propose → apply → re-run → compare → commit or
reject. A proposal only ever has to be a good guess; the engine is what makes
acting on it safe, and the check is affordable because re-deriving is what this
engine is for. Deletes iterate, terminating because each round strictly shrinks
a finite EDB and safety guarantees an empty one derives nothing.

This is the structural advantage over a hand-written lens library: the forward
direction is *derived from a declarative program*, so every inverse — inferred
or annotated — is machine-checkable against it. A wrong annotation is caught,
not silently corrupting.

**Language constraints a generator must respect** (pinned in
`tests/executing/comparisons.test.ts`): a computed value must sit in the head,
because body comparisons filter over already-bound variables and cannot
introduce one; arithmetic is flat and left-to-right with no precedence. So
multi-step expressions thread through helper relations, one operation per rule.

## Engine bugs found by the fuzzer

- **Head-constant collision** (fixed). Two rules over the same body with a
  constant in different head positions produced each other's results, and when
  both wrote the same relation a row vanished. The shadow compiler emits
  precisely this shape, so it was silently corrupting backward propagation.
- **Constant in a negated atom plus a comparison** (fixed). The trace aligning a
  negated atom's arguments demanded a signature-map entry for every position; a
  constant has no variable name, so it has none — and can never match a trace
  argument anyway. Either ingredient alone always planned, which is why it went
  unnoticed.
- **Existence tests** (fixed). An atom sharing no variable with the rest of the
  body and contributing no head column left a zero-column intermediate the
  planner refused to name. It now builds a *unit* collection — the empty tuple,
  present iff the input is non-empty — and the cartesian join that already
  existed gates its partner on it. The dedupe on the unit is semantics, not
  optimisation: without it a relation of N rows multiplies its partner N-fold.
  Fixing the positive case made the negated form (`!E0(0)`) reachable for the
  first time, and `buildAntijoin` needed the cartesian branch its positive
  counterpart already had.

All three were found by the fuzzer, and all three were written first as
`it.fails` carrying the results the rules actually mean — so each flipped
loudly when fixed, which is how the fixes are known to be right rather than
merely quiet.

## Cost

Measured, not argued. Sink emissions for one request, batch versus a loaded
session:

| database | batch | incremental |
| --- | --- | --- |
| 5 rows | 8 | 4 |
| 80 rows | 83 | 4 |

Batch re-derives everything, so its cost tracks the database; an incremental
request touches only what the seed reaches. Wall-clock agrees — request cost is
flat from 200 to 8000 rows.

One prediction was wrong. I expected SIP to be the optimisation that makes this
cheap, since a seeded request is a single highly selective row. It costs about
5x instead, at every size tried, and `-O 2` (planning) is best or tied
throughout. Incremental maintenance has already built the join index, so the
body replay is already a probe; SIP's extra semijoin transformations are
per-advance overhead, and the scan it avoids is one a maintained graph never
performs.

## Testing

The forward engine is the oracle throughout. Hand-picked shapes cover the cases
we designed for; a program generator (`tests/shadow/_gen.ts`) covers the ones we
didn't, emitting random stratified programs — arities, shared variables,
constants, placeholders, negation, filters, chained IDBs, multi-rule heads, and
optionally recursion. It consumes a flat pool of naturals through a cursor, so
shrinking the pool shrinks the program and a counterexample prints as readable
rules.

Properties assert soundness, groundedness, stability (GetPut), completeness
(one pass for monotone programs, fixpoint in general), monotonicity, and that
`resolveBackward` never reports `ok` without the request holding. Each carries a
floor on how often it was genuinely exercised, so the suite can't go vacuous.

## Not done

- Insert requests other than the negation flip; no templates for existentials.
- Head arithmetic, join write-side, and recursion cuts are refused rather than
  annotatable.
- The generator is numeric-only and non-recursive by default.
- flow-md integration needs typed IDB decls: `vault.ts` emits `.decl Q<hash>()`
  and lets arity be inferred, but a `Seed_` EDB needs real attributes. A
  mistyped seed currently yields zero candidates rather than an error, which
  should be loud.

## References

- Bancilhon & Spyratos, *Update Semantics of Relational Views*, TODS 1981 —
  constant complement; what `.put into` would name.
- Hofmann, Pierce, Wagner, *Edit Lenses*, POPL 2012 — the delta formulation.
- Diskin, Xiong, Czarnecki, *From state- to delta-based bidirectional model
  transformations*, ICMT 2011.
- Foster et al., *Combinators for Bidirectional Tree Transformations*, TOPLAS
  2007 — lens laws; the state-lens baseline.
- Green, Karvounarakis, Tannen, *Provenance Semirings*, PODS 2007 — why-provenance
  as the input to the ambiguous cases, rather than as the mechanism.
- [bireactive](https://github.com/OrionReed/bireactive) — `src/core/lenses/aggregates.ts`
  for the pseudoinverse, `src/formats/lens.ts` for complement-carrying text lenses.
