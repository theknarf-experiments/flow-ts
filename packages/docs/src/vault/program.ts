// The vault's Datalog, shaped like flow-md's: a few facts lowered from source
// text, and views defined over them by rule.
//
// The views are chosen so each one exercises a different part of the backward
// direction, because that is what the demo is for:
//
//   Task      a projection — `line` is dropped, so a write has to recover it
//             by replaying the body against the current facts
//   Open      a projection *and* a filter, so only rows that passed the filter
//             are candidates
//   Agenda    a join — `title` comes from Doc and `text` from MdTask, so one
//             table writes into two different source relations
//   Outline   headings, where `depth` is a number the writer turns back into
//             a run of `#`
//   Effort    an aggregate, where a write is a distribution rather than a copy
//   Line      a view with *two* rules, so an insert has to pick one of them
//   Load      a view that is deliberately not writable at all
//   Minutes   a head that *computes* a column, so a write has to invert it
//   Missing   a view built on a negated atom, where the two directions swap
//
// `Doc(path, title)` is *derived* — from the note's level-1 heading — rather
// than stored, so editing an Agenda title has to trace through two rules to
// land on a line of text. That is the case a hand-written lineage pass finds
// hardest, and the one shadow rules handle without being told anything.
//
// (A real vault would want "the *first* level-1 heading". Datalog has no
// notion of first, and the demo's notes have one apiece, so this takes them
// all and leaves the ordering problem where it belongs — out of scope.)
//
// `Task` carries the one annotation in the program, and it earns it. Deleting
// or rewriting a task works with no help: the row exists, so replaying the body
// finds the line it came from. *Adding* one has no row to replay, so `line` has
// no value and nothing in the rules suggests one — the compiler refuses and
// says so. `.put insert defaults(l = 0)` supplies it, and the writer reads 0 as
// "append", which is exactly flow-md's convention for locator columns it can't
// know until the file is re-parsed.

import { parseProgram } from 'flow-ts'

export const SOURCE = `\
.in
.decl MdTask(path: string, line: number, status: string, text: string)
.decl MdHeading(path: string, line: number, depth: number, text: string)
.decl MdEstimate(path: string, line: number, hours: number)
.decl MdTag(path: string, tag: string)
.decl Vocab(tag: string)

.out
.decl Doc(path: string, title: string)
.decl Task(path: string, status: string, text: string)
.put insert defaults(l = 0)
.decl Open(path: string, text: string)
.decl Agenda(title: string, text: string)
.decl Outline(title: string, depth: number, text: string)
.decl Effort(path: string, hours: number)
.put spread(min)
.decl Line(path: string, text: string)
.put insert via MdTask defaults(l = 0, s = "open")
.decl Load(path: string, open: number)
.put none
.decl Minutes(path: string, text: string, minutes: number)
.decl Missing(path: string, title: string, tag: string)
.put into MdTag

Doc(p, title) :- MdHeading(p, l, 1, title).
Task(p, s, t) :- MdTask(p, l, s, t).
Open(p, t) :- MdTask(p, l, "open", t).
Agenda(title, t) :- Open(p, t), Doc(p, title).
Outline(title, d, t) :- MdHeading(p, l, d, t), Doc(p, title).
Effort(p, sum(h)) :- MdEstimate(p, l, h).
Line(p, t) :- MdTask(p, l, s, t).
Line(p, t) :- MdHeading(p, l, d, t).
Load(p, count(t)) :- Open(p, t).
Minutes(p, t, h * 60) :- MdEstimate(p, l, h), MdTask(p, l, s, t).
Missing(p, title, g) :- Doc(p, title), Vocab(g), !MdTag(p, g).
`

export const program = parseProgram(SOURCE, { grammarSource: 'vault.dl' })

/** The `.put into Open` line the Agenda panel offers to add, and where it goes.
 *  Kept here so the demo and the program agree on the exact text. */
export const AGENDA_INTO = {
  after: '.decl Agenda(title: string, text: string)',
  line: '.put into Open',
}

/** The tag palette. An EDB the application supplies — see the note above on
 *  why it is not derived from the tags actually in use. */
export const VOCAB: readonly string[] = ['urgent', 'errand', 'waiting']

/** The notes the demo starts from. */
export const SEED_NOTES: Record<string, string> = {
  'work.md': `# Work #urgent

## This week
- [ ] write the design doc (3h)
- [x] review the benchmark (1h)
- [ ] reply to sam (2h)
`,
  'home.md': `# Home

- [ ] water the plants (1h)
- [ ] book the dentist (1h)
`,
}
