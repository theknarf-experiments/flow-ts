// MVR key-value store programs from Stewen §4.2.1.
//
// Two variants, both backed by the same EDBs (Set + Pred), but
// differing in which IDB rows survive when ops arrive out of causal
// order. Same UI drives both — switch at runtime via
// `Store.replaceProgram` and the EDB rows replay against the new
// rules without losing user data.
//
// `LeafByKey` is an extra IDB this demo adds on top of the thesis
// programs: it surfaces the current "leaf" set per key so the UI can
// emit Pred edges from every concurrent leaf to a freshly-written
// value without scanning the Set / Overwritten relations by hand.

import { parseProgram, type Program } from '@flow-ts/parsing'

export const MVR_NO_CB_SOURCE = `\
.in
.decl Set(rep_id: number, ctr: number, key: string, value: string)
.decl Pred(from_rep: number, from_ctr: number, to_rep: number, to_ctr: number)

.out
.decl Overwritten(rep_id: number, ctr: number)
.decl LeafByKey(rep_id: number, ctr: number, key: string)
.decl MvrStore(key: string, value: string)

Overwritten(r, c) :- Pred(r, c, _, _).
LeafByKey(r, c, k) :- Set(r, c, k, _), !Overwritten(r, c).
MvrStore(k, v)     :- Set(r, c, k, v), !Overwritten(r, c).
`

export const MVR_WITH_CB_SOURCE = `\
.in
.decl Set(rep_id: number, ctr: number, key: string, value: string)
.decl Pred(from_rep: number, from_ctr: number, to_rep: number, to_ctr: number)

.out
.decl Overwritten(rep_id: number, ctr: number)
.decl Overwrites(rep_id: number, ctr: number)
.decl IsRoot(rep_id: number, ctr: number)
.decl IsLeaf(rep_id: number, ctr: number)
.decl IsCausallyReady(rep_id: number, ctr: number)
.decl LeafByKey(rep_id: number, ctr: number, key: string)
.decl MvrStore(key: string, value: string)

Overwritten(r, c) :- Pred(r, c, _, _).
Overwrites(r, c)  :- Pred(_, _, r, c).

IsRoot(r, c) :- Set(r, c, _, _), !Overwrites(r, c).
IsLeaf(r, c) :- Set(r, c, _, _), !Overwritten(r, c).

IsCausallyReady(r, c) :- IsRoot(r, c).
IsCausallyReady(r, c) :- IsCausallyReady(from_r, from_c), Pred(from_r, from_c, r, c).

LeafByKey(r, c, k) :- Set(r, c, k, _), IsLeaf(r, c), IsCausallyReady(r, c).
MvrStore(k, v)     :- IsLeaf(r, c), IsCausallyReady(r, c), Set(r, c, k, v).
`

export type MvrVariant = 'no_cb' | 'with_cb'

export const MVR_SOURCES: Record<MvrVariant, string> = {
  no_cb: MVR_NO_CB_SOURCE,
  with_cb: MVR_WITH_CB_SOURCE,
}

export function parseMvr(variant: MvrVariant): Program {
  return parseProgram(MVR_SOURCES[variant], { grammarSource: `mvr.${variant}.dl` })
}
