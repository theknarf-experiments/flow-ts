// The Datalog program backing the demo. Three EDBs (Node, Source,
// Edge) and one recursive IDB (Reach). The program is intentionally
// tiny so the focus stays on the React integration, not the Datalog.
//
// `.input <file>.csv` declarations only matter for the CLI's batch
// mode (where the executor reads facts off disk). In the browser
// we populate EDBs by calling `collection.insert(row)`, so they're
// omitted here. Likewise `.rule` is just a section header for the
// batch CLI's `.dl` files — the grammar treats it as optional.

import { parseProgram } from '@flow-ts/parsing'

export const SOURCE = `\
.in
.decl Node(id: number)
.decl Source(id: number)
.decl Edge(src: number, dst: number)

.out
.decl Reach(id: number)

Reach(y) :- Source(y).
Reach(z) :- Reach(y), Edge(y, z).
`

export const program = parseProgram(SOURCE, { grammarSource: 'demo.dl' })
