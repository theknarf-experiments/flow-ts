// The Datalog program backing the demo. Two EDBs (Node, Edge) and one
// recursive IDB (Reach) that computes everything reachable from a
// fixed `source` row in Node. The program is intentionally tiny so
// the focus stays on the React integration, not the Datalog.
//
// Schema:
//   .decl Node(id: number)                                   -- EDB
//   .decl Source(id: number)                                 -- EDB
//   .decl Edge(from: number, to: number)                     -- EDB
//   .decl Reach(id: number)                                  -- IDB
//
// Rules:
//   Reach(y) :- Source(y).
//   Reach(z) :- Reach(y), Edge(y, z).

import { parseProgram } from '@flow-ts/parsing'

export const SOURCE = `\
.in
.decl Node(id: number)
.input Node.csv

.decl Source(id: number)
.input Source.csv

.decl Edge(src: number, dst: number)
.input Edge.csv

.printsize
.decl Reach(id: number)

.rule
Reach(y) :- Source(y).
Reach(z) :- Reach(y), Edge(y, z).
`

export const program = parseProgram(SOURCE, { grammarSource: 'demo.dl' })
