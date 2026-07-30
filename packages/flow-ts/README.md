# flow-ts

A Datalog engine in TypeScript, built on incremental dataflow. It parses a
program, stratifies and plans it, and runs it as a dataflow graph whose operators
are inherently incremental: feed it new facts later and only the affected
derivations re-run.

No filesystem, no native code, no `node:` imports — it runs unchanged in Node,
the browser, Deno or a worker.

```bash
npm install flow-ts
```

## Two ways in

**Batch** — facts in, derived rows out:

```ts
import { parseProgram, executeProgram } from 'flow-ts'

const program = parseProgram(`
  .in
  .decl Edge(a: number, b: number)

  ?- Reach(a, b) :- Edge(a, b).
  ?- Reach(a, c) :- Reach(a, b), Edge(b, c).
`)

executeProgram(program, new Map([['Edge', [[1, 2], [2, 3]]]]), {}, (rel, row, diff) => {
  if (diff > 0) console.log(rel, row)
})
// Reach [1,2]  Reach [2,3]  Reach [1,3]
```

**Streaming** — a long-lived session you push deltas into:

```ts
import { openSession } from 'flow-ts'

const session = openSession(program, {}, (rel, row, diff) =>
  console.log(diff > 0 ? '+' : '-', rel, row),
)

session.update('Edge', [1, 2])
session.update('Edge', [2, 3])
session.advance()            // + Reach(1,2), Reach(2,3), Reach(1,3)

session.update('Edge', [2, 3], -1)
session.advance()            // - Reach(2,3), Reach(1,3)
```

Operators keep their own state across `advance()` — the join indexes, the
distinct tables — so each tick costs the delta rather than a re-run. Retraction
is the same machinery with the opposite sign, including under recursion.

## The language

Stratified recursion, negation, comparisons, head arithmetic, and
`count`/`sum`/`min`/`max` with an implicit group-by. Columns are `number`,
`float`, `string`, or `any` for data whose shape is the data's business. A rule
can bring its own head declaration:

```datalog
?- Payroll(dept, sum(s)) :- Person(i, n, dept), Salary(i, s).
```

…and dropping the head too gives Prolog's bare goal, reported under a generated
name.

It also runs **backwards**. A derived row can be edited and the change resolved
onto the facts that produced it, by compiling the inverse of each rule as more
Datalog:

```ts
import { parseProgram, openBackwardSession } from 'flow-ts'

const program = parseProgram(`
  .in
  .decl Employee(id: number, name: string, dept: string)

  ?- Roster(name, dept) :- Employee(i, name, dept).
`)

const session = openBackwardSession(program, {
  views: ['Roster'],                       // opt in per view
  parse: (src) => parseProgram(src),       // the inverse is Datalog, read back in
})
session.update('Employee', [1, 'alice', 'eng'])
session.advance()

session.resolve({ rel: 'Roster', row: ['alice', 'eng'], newRow: ['alicia', 'eng'] })
// { status: 'ok', changes: [{ kind: 'upd', rel: 'Employee',
//   row: [1, 'alice', 'eng'], newRow: [1, 'alicia', 'eng'] }], rounds: 1 }
```

`Roster` drops the id, so rewriting a name means finding the `Employee` row it
was copied from — which the inverse rule does by replaying the body.

Every proposal is checked by re-deriving before it commits, so an inverse that
would have been wrong is reported rather than applied.

## Documentation

The [documentation site](http://experiments.theknarf.com/flow-ts/) is a tutorial
of eleven lessons, one per language feature, where every program is editable and
every table is live — the engine runs in the page. It is the best way to learn
what the language does.

For React, [`@flow-ts/react`](https://www.npmjs.com/package/@flow-ts/react) puts
a `Store` over a session with hooks that re-render on the derivations that
changed.

## Credits

A port of the Rust [FlowLog](https://www.flowlog-rs.com/) engine ([VLDB 2026
paper](https://arxiv.org/pdf/2511.00865)), on a vendored fork of
[TanStack DB](https://github.com/TanStack/db)'s incremental-dataflow package
(MIT — see `src/db-ivm/LICENSE`), itself derived from
[`@electric-sql/d2ts`](https://github.com/electric-sql/d2ts).

MIT.
