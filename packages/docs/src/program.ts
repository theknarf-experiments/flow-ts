// The Datalog program backing the demo. A small friend graph:
//
//   • `Person(id, name)` pairs a numeric id with a human-readable name.
//   • `Me(id)` picks out "you" — a single-row EDB.
//   • `Friend(a, b)` is a directed friendship edge (so `b` shows up in
//     your network when you add `Friend(you, b)`).
//   • `Reach(x, y)` is the transitive closure of `Friend` — the
//     classic recursive reach pattern, but doing it on Person ids
//     means a join on `Person` at the head turns ids back into names.
//   • `ICanReach(name)` is the user-facing answer: every person whose
//     name you can reach by following friendship chains from `Me`.
//
// `.input <file>.csv` declarations only matter for the CLI's batch
// mode (where the executor reads facts off disk). In the browser we
// populate EDBs by calling `collection.insert(row)`, so they're
// omitted here. Likewise `.rule` is just a section header for the
// batch CLI's `.dl` files — the grammar treats it as optional.

import { parseProgram } from '@flow-ts/parsing'

export const SOURCE = `\
.in
.decl Person(id: number, name: string)
.decl Me(id: number)
.decl Friend(a: number, b: number)
.decl Weight(id: number, kg: float)

.out
.decl Reach(a: number, b: number)
.decl ICanReach(name: string)
.decl ReachableWeight(name: string, kg: float)

Reach(x, y) :- Friend(x, y).
Reach(x, z) :- Reach(x, y), Friend(y, z).

ICanReach(name) :- Me(me), Reach(me, id), Person(id, name).
ReachableWeight(name, kg) :- Me(me), Reach(me, id), Person(id, name), Weight(id, kg).
`

export const program = parseProgram(SOURCE, { grammarSource: 'demo.dl' })
