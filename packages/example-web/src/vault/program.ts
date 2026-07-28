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
//
// `Doc(path, title)` is *derived* — from the note's level-1 heading — rather
// than stored, so editing an Agenda title has to trace through two rules to
// land on a line of text. That is the case a hand-written lineage pass finds
// hardest, and the one shadow rules handle without being told anything.
//
// (A real vault would want "the *first* level-1 heading". Datalog has no
// notion of first, and the demo's notes have one apiece, so this takes them
// all and leaves the ordering problem where it belongs — out of scope.)

import { parseProgram } from '@flow-ts/parsing'

export const SOURCE = `\
.in
.decl MdTask(path: string, line: number, status: string, text: string)
.decl MdHeading(path: string, line: number, depth: number, text: string)

.out
.decl Doc(path: string, title: string)
.decl Task(path: string, status: string, text: string)
.decl Open(path: string, text: string)
.decl Agenda(title: string, text: string)
.decl Outline(title: string, depth: number, text: string)

Doc(p, title) :- MdHeading(p, l, 1, title).
Task(p, s, t) :- MdTask(p, l, s, t).
Open(p, t) :- MdTask(p, l, "open", t).
Agenda(title, t) :- Open(p, t), Doc(p, title).
Outline(title, d, t) :- MdHeading(p, l, d, t), Doc(p, title).
`

export const program = parseProgram(SOURCE, { grammarSource: 'vault.dl' })

/** The notes the demo starts from. */
export const SEED_NOTES: Record<string, string> = {
  'work.md': `# Work

## This week
- [ ] write the design doc
- [x] review the benchmark
- [ ] reply to sam
`,
  'home.md': `# Home

- [ ] water the plants
- [ ] book the dentist
`,
}
