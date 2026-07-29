// List CRDT (RGA-like) as a Datalog query — same as
// `examples/list_crdt.dl` but inlined so the browser bundle doesn't
// have to fetch anything from disk.
//
// Each character is an `Insert(rep_id, ctr, parent_rep, parent_ctr,
// value)` op; the parent points at the character it's inserted after,
// or `(0, 0)` for inserts at the start. `Remove(rep, ctr)` tombstones
// a character without breaking children pointing at it.
//
// The output `ListElem(prev_rep, prev_ctr, value, next_rep, next_ctr)`
// is a linked list of visible (non-tombstoned) characters. Walking it
// from the sentinel `(0, 0)` and collecting the `value` column gives
// you the rendered text.

import { parseProgram } from '@flow-ts/parsing'

export const TEXT_SOURCE = `\
.in
.decl Insert(rep_id: number, ctr: number, parent_rep: number, parent_ctr: number, value: string)
.decl Remove(elem_rep: number, elem_ctr: number)

.out
.decl ListElem(prev_rep: number, prev_ctr: number, value: string, next_rep: number, next_ctr: number)
.decl FirstChild(parent_rep: number, parent_ctr: number, child_rep: number, child_ctr: number)
.decl NextSibling(c1_rep: number, c1_ctr: number, c2_rep: number, c2_ctr: number)
.decl NextElem(prev_rep: number, prev_ctr: number, next_rep: number, next_ctr: number)

.decl LaterChild(parent_rep: number, parent_ctr: number, child_rep: number, child_ctr: number)
.decl Sibling(c1_rep: number, c1_ctr: number, c2_rep: number, c2_ctr: number)
.decl LaterSibling(c1_rep: number, c1_ctr: number, c2_rep: number, c2_ctr: number)
.decl LaterIndirectSibling(c1_rep: number, c1_ctr: number, c3_rep: number, c3_ctr: number)
.decl HasNextSibling(c_rep: number, c_ctr: number)
.decl NextSiblingAnc(c_rep: number, c_ctr: number, anc_rep: number, anc_ctr: number)
.decl HasChild(parent_rep: number, parent_ctr: number)
.decl HasValue(elem_rep: number, elem_ctr: number)
.decl NextElemSkipTombstones(prev_rep: number, prev_ctr: number, next_rep: number, next_ctr: number)
.decl NextVisible(prev_rep: number, prev_ctr: number, next_rep: number, next_ctr: number)

LaterChild(pr, pc, cr, cc) :- Insert(sr, sc, pr, pc, _), Insert(cr, cc, pr, pc, _), sc > cc.
LaterChild(pr, pc, cr, cc) :- Insert(sr, sc, pr, pc, _), Insert(cr, cc, pr, pc, _), sc = cc, sr > cr.

FirstChild(pr, pc, cr, cc) :- Insert(cr, cc, pr, pc, _), !LaterChild(pr, pc, cr, cc).

Sibling(c1r, c1c, c2r, c2c) :- Insert(c1r, c1c, pr, pc, _), Insert(c2r, c2c, pr, pc, _).
LaterSibling(c1r, c1c, c2r, c2c) :- Sibling(c1r, c1c, c2r, c2c), c1c > c2c.
LaterSibling(c1r, c1c, c2r, c2c) :- Sibling(c1r, c1c, c2r, c2c), c1c = c2c, c1r > c2r.

LaterIndirectSibling(c1r, c1c, c3r, c3c) :-
    LaterSibling(c1r, c1c, c2r, c2c),
    LaterSibling(c2r, c2c, c3r, c3c).

NextSibling(c1r, c1c, c2r, c2c) :-
    LaterSibling(c1r, c1c, c2r, c2c),
    !LaterIndirectSibling(c1r, c1c, c2r, c2c).

HasNextSibling(cr, cc) :- NextSibling(cr, cc, _, _).

NextSiblingAnc(cr, cc, ar, ac) :- NextSibling(cr, cc, ar, ac).
NextSiblingAnc(cr, cc, ar, ac) :-
    Insert(cr, cc, pr, pc, _),
    !HasNextSibling(cr, cc),
    NextSiblingAnc(pr, pc, ar, ac).

HasChild(pr, pc) :- Insert(_, _, pr, pc, _).

NextElem(pr, pc, nr, nc) :- FirstChild(pr, pc, nr, nc).
NextElem(pr, pc, nr, nc) :- !HasChild(pr, pc), NextSiblingAnc(pr, pc, nr, nc).

HasValue(e, c) :- Insert(_, _, e, c, _), e = 0, c = 0.
HasValue(e, c) :- Insert(e, c, _, _, _), !Remove(e, c).

NextElemSkipTombstones(pr, pc, nr, nc) :- NextElem(pr, pc, nr, nc).
NextElemSkipTombstones(pr, pc, nr, nc) :-
    NextElem(pr, pc, vr, vc),
    !HasValue(vr, vc),
    NextElemSkipTombstones(vr, vc, nr, nc).

NextVisible(pr, pc, nr, nc) :-
    HasValue(pr, pc),
    NextElemSkipTombstones(pr, pc, nr, nc),
    HasValue(nr, nc).

ListElem(pr, pc, value, nr, nc) :-
    NextVisible(pr, pc, nr, nc),
    Insert(nr, nc, _, _, value).
`

export const textProgram = parseProgram(TEXT_SOURCE, { grammarSource: 'text.dl' })
