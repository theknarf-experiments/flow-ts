# flow-ts

A Datalog engine in TypeScript, built on top of incremental dataflow.

flow-ts is a port of the Rust [FlowLog](https://www.flowlog-rs.com/) engine (VLDB 2026) onto a vendored fork of [Tanstack's db-ivm](https://github.com/TanStack/db) (which is itself a fork of [`@electric-sql/d2ts`](https://github.com/electric-sql/d2ts) with the time/version machinery stripped out). It parses Datalog programs, stratifies and plans them, and executes them as a dataflow graph whose operators are inherently incremental: feed it new facts later and only the affected derivations re-run.

## What you can do with it

- Run a Datalog program against EDB fact files and write IDB outputs.
- Open a long-lived session, push EDB updates over time, observe IDB diffs as they happen — incrementally, without re-evaluating from scratch.
- Use the executor as a library from Node *or the browser* (the executor and reading packages have zero filesystem dependencies).

## Status

- 17 of 18 upstream FlowLog example programs match the Rust engine row-for-row on synthetic test data. The one mismatch (`cc.dl`) is a semantic divergence around how aggregation logs are written under recursion, not a bug.
- Datalog features supported: stratified recursion, negation, head arithmetic, `min`/`max`/`sum`/`count` aggregations, sideways info passing (SIP, `-O 1`), planning optimisation (`-O 2`), and backward propagation (editing a derived row and having it land on the facts behind it).
- Property-based + integration tests in `packages/flow-ts/tests/`.

## Queries: `?-`

A rule can bring its own head declaration:

```datalog
?- Payroll(dept, sum(s)) :- Person(i, n, dept), Salary(i, s).
```

No `.out` section, no `.decl`, no column types. It is shorthand for
`.decl Payroll()` plus the rule — a declaration the language already had, since
`.decl Foo()` leaves the schema to the rules and the type inference in
`packages/flow-ts/src/typing/` recovers it when something needs it (the
backward-propagation path does). So a query is an ordinary IDB from the moment
it parses: it plans, executes, recurses, and can be written back through like
any other relation, and the CLI prints it like any other output.

Drop the head as well and you have Prolog's bare goal:

```datalog
?- Person(i, n, dept), Salary(i, s), s > 100.
```

Its columns are the variables its body binds, in order of first appearance —
here `(i, n, dept, s)`, the join key included, because a key has to be named to
join. `_` drops a column nothing needs, but not one doing work; when you want to
choose the columns, name the head. It still needs a relation to land in, so one
is named for you: `Query1`, `Query2`, in source order, stepping past any name
the program already uses. That is the right answer for a name nothing outlives,
and the reason to accept the goal form rather than insist a throwaway be
christened.

A bare goal has to bind at least one variable, since the columns *are* the
variables; `?- Person(1, "alice", "eng").` is a yes/no question with nothing to
show and is refused by saying so.

Give two `?-` rules the same head and you have written a union. An explicit
`.decl` of the same name wins, since a declaration is a statement and the query
is shorthand for not having made one.

## Column types

Four, declared per column in a `.decl`:

| type | holds | notes |
|---|---|---|
| `number` | integer | float64, so the safe-integer range |
| `float` | decimal | same JS representation as `number`; they widen together |
| `string` | text | stored inline, not interned |
| `any` | either of the above | for a column whose shape is the data's business, not the program's |

`any` is a departure from upstream FlowLog, and it is here because this engine
runs where the data often isn't characterised: a property bag whose values are
numbers for some keys and strings for others, an id that is numeric in one
source and a slug in another. It costs nothing at runtime — rows cross the
dataflow boundary as self-describing fields, so a cell has always carried its
own type and `any` simply declines to constrain it:

```datalog
.in
.decl Prop(entity: string, key: string, value: any)

.out
.decl Age(entity: string, value: any)

Age(e, v) :- Prop(e, "age", v).
```

What `any` does *not* do is widen what a cell can be — it is still a number or
a string, the two things a row cell is — or relax the operations. Arithmetic and
`sum`/`min`/`max` still need a number and say so by name when they don't get
one; a comparison compares the values it actually finds. And a numeric-looking
string stays a string: `"1"` and `1` are different values and do not join.

Two rules that disagree about a column are still a conflict rather than being
quietly widened to `any` — `any` is something you declare, not something
inference falls back on. The one place a real decision is made is reading a
column from a fact file, where a cell is text and nothing else: a cell that
parses wholly as a finite number is read as one, so `007` arrives as `7`. If you
know the column is text, `string` says so.

## Install

The toolchain is pinned: Node via `mise.toml` (24.15.0 LTS), pnpm via
corepack (`packageManager` field in `package.json`). With
[mise](https://mise.jdx.dev) and corepack on your machine:

```bash
mise install                # fetches Node 24.15.0 if missing
corepack enable             # one-time, lets pnpm resolve from packageManager
pnpm install
pnpm -r run build
```

If you already have Node ≥ 20 and pnpm 9 on your PATH, those steps reduce to
just the last two.

## CLI usage

### Batch

```bash
node packages/cli/dist/bin.js -p path/to/program.dl -f path/to/facts/ -c out/
```

`--help` lists every flag; `-O <0..3>` picks the optimisation level (0 as-is,
1 sideways info passing, 2 planning, 3 both) and `--stream` is described below.

If `-c <dir>` is not given, IDB rows are printed to stdout one per line.

### Streaming

After loading the initial fact files, `--stream` reads incremental EDB updates from stdin. Output is a `<sign><N>\t<rel>\t<col>,<col>,...` per IDB diff per tick.

Line protocol (one directive per line):

| line                          | meaning                                                  |
|-------------------------------|----------------------------------------------------------|
| `+ <Rel> <c1>,<c2>,...`       | insert a row                                             |
| `- <Rel> <c1>,<c2>,...`       | retract a row                                            |
| blank line / `.advance`       | drive the graph to a fixpoint and emit diffs to stdout    |
| `.quit`                       | stop reading (`EOF` also works)                          |
| lines starting with `#`       | comments, ignored                                        |

Example:

```bash
$ cat reach.dl
.in
.decl Source(id: number)  .input Source.csv
.decl Arc(x: number, y: number)  .input Arc.csv
.printsize
.decl Reach(id: number)

.rule
Reach(y) :- Source(y).
Reach(y) :- Reach(x), Arc(x, y).
```

```bash
$ printf -- "\n+ Arc 3,4\n\n- Arc 2,3\n\n" | flow-ts -p reach.dl -f . --stream
+1	Reach	1
+1	Reach	2
+1	Reach	3   # initial fixpoint over Source={1}, Arc={(1,2),(2,3)}
+1	Reach	4   # after Arc(3,4) added
-1	Reach	3   # after Arc(2,3) retracted — 3 and 4 fall out
-1	Reach	4
```

### Inspect

`flow-ts inspect <program.dl>` dumps the parsed program, the stratification, and the execution plan without running anything. Useful when a rule isn't behaving the way you expect — you can see which stratum it ended up in, what's marked recursive, and how the planner broke it into transformations.

```bash
$ flow-ts inspect reach.dl
Program: reach.dl
========

EDBs (2):
  Source(id: number) [Source.csv]
  Arc(x: number, y: number) [Arc.csv]

IDBs (1):
  Reach(id: number)

Rules (2):
  [0] Reach(y) :- Source(y).
  [1] Reach(y) :- Reach(x), Arc(x, y).

Strata
======

#0 non-recursive [1 rule]
  Reach(y) :- Source(y).

#1 recursive [1 rule]
  Reach(y) :- Reach(x), Arc(x, y).

Plan
====
...
```

Add `--json` for machine-readable output, or `-O 1` / `--no-sharing` to inspect a plan under different planner knobs.

## Library usage

The executor is published-shaped (not on npm yet) as `flow-ts`. Two packages are
meant to go out — `flow-ts`, usable on its own, and `@flow-ts/react` on top of
it — and everything else here is private. Two entry points:

### Batch — `executeProgram`

```ts
import { executeProgram, parseProgram } from 'flow-ts'

const program = parseProgram(source)
const facts = new Map([
  ['Source', [[1]]],
  ['Arc',    [[1, 2], [2, 3], [3, 4]]],
])

executeProgram(program, facts, {}, (rel, row, diff) => {
  if (diff > 0) console.log(rel, row)
})
// → Reach [1], Reach [2], Reach [3], Reach [4]
```

### Streaming — `openSession`

```ts
import { openSession } from 'flow-ts'

const session = openSession(program, {}, (rel, row, diff) => {
  console.log(`${diff > 0 ? '+' : ''}${diff}`, rel, row)
})

session.update('Source', [1])
session.update('Arc',    [1, 2])
session.advance()           // emits Reach(1), Reach(2)

session.update('Arc',    [2, 3])
session.advance()           // emits +Reach(3)

session.update('Arc',    [1, 2], -1)
session.close()             // emits -Reach(2), -Reach(3)
```

Operators carry their own state across `advance()` calls (the join indexes, the distinct hash table, etc.) so each tick only processes the delta — true incremental Datalog, not a re-run.

## Architecture

```
packages/
  flow-ts/      The engine. One package with several internal modules:
                  ast/         Typed AST — the parser builds it, the executor reads it
                  strata/      Kosaraju's SCC → stratified evaluation order
                  catalog/     Per-rule signatures, SIP rewriting, dependent atoms
                  optimizing/  Prim's MST join-order optimisation
                  planning/    Logical IR: TransformationFlow trees, head arithmetic
                  reading/     Row type, encoding, in-memory rels (no I/O)
                  executing/   Dataflow assembly + executor (executeProgram, openSession)
                  parsing/     Datalog grammar (peggy) → parseProgram
                  db-ivm/      Vendored fork of Tanstack DB's ivm (MIT, see its
                               LICENSE) + a queue-driven `iterate` operator
  cli/          flow-ts binary, argv parsing (commander+zod), fact CSV I/O.
                Private: it is for driving the engine locally, and folding it
                into the core would put commander and zod in every consumer.
  react/        React bindings: Store / Collection / useLiveQuery
  docs/         Documentation site: a Vite + React + react-router SPA running
                the engine in the browser — a per-feature tutorial plus four
                larger demos
```

The executor compiles a parsed `Program` into a db-ivm dataflow graph, one stratum at a time. Recursive strata get a queue-driven `iterate` operator (defined in `packages/flow-ts/src/db-ivm/operators/iterate.ts`) that's the moral equivalent of differential-dataflow's `scope.iterative` but without the time-tracking machinery — operators are stateful, so each iteration's body sees only the new diff, and convergence is detected by db-ivm's standard "no pending work" loop.

Rows cross the dataflow boundary as comma-joined strings (`"1,2,3,"`) rather than `number[]`: db-ivm uses JS `Map` for its top-level indexes, which means object identity matters, but JS hashes strings natively. The string boundary sidesteps both that and `JSON.stringify`'s aversion to `bigint`. Inside operators we project columns at the string level when possible, falling back to `number[]` only for arithmetic / compare evaluation.

## Browser usage — and the docs

`flow-ts` and the rest of the stack are filesystem-free, so the whole engine runs in the browser unchanged. `packages/docs/` is a Vite + React + react-router site that does exactly that, and it's where the language is documented. It builds to static pages — one HTML file per route, with the derived tables already rendered — and deploys to GitHub Pages:

```bash
pnpm -F docs run dev     # http://localhost:5173
```

It's in two halves. The **tutorial** is eleven lessons, one per language feature, ordered so each only uses what came before — facts and rules, joins, filters, arithmetic, union, recursion, negation, aggregation, incremental retraction, ad-hoc queries, and writing back. The last splits into three parts (11.1–11.3), one per `.put` policy that supplies what the rules leave open: `insert`, `spread`, and `into`/`none`. Every page is live: edit a fact, or edit the rules themselves, and watch the derived tables update. The **demos** are the same engine at a larger size — a friend graph, a markdown vault that writes edits back into the source text, and two CRDTs from Stewen 2025 expressed as Datalog queries.

The lessons are data (`src/lessons/lessons.ts`), and every one of them is executed against its seed facts by `packages/docs/tests/lessons.test.ts`, which asserts the rows the prose claims and checks that between them the lessons still cover the language. Documentation that stops being true fails the build.

The React glue is a Tanstack-DB-inspired pattern: one `Store` wraps a session, `Collection<T>` is a typed EDB handle, `useLiveQuery(store, idb)` subscribes to an IDB head, `useWritableQuery` adds the write-back operations, and `useAdHocQuery` runs a one-off program over the facts a store already holds. Multiple components can subscribe to the same store and re-render incrementally as the EDBs change.

The whole pipeline (parser, planner, db-ivm runtime, shadow compiler, router, table and React glue) ships in about 100 kB gzipped.

## Tests

```bash
pnpm test                              # 367 unit + property + e2e tests
pnpm -F cli test -- vs-rust   # diff TS output against the Rust binary
```

The vs-rust oracle runs each upstream `.dl` example through both the Rust `executing` binary (from the `dbflow` repo) and our TS CLI on identical synthetic facts, then compares IDB CSV outputs row-by-row. It auto-skips if the Rust binary isn't available on disk (or set `RUST_FLOWLOG` to override the path).

## Acknowledgements

- The Rust [FlowLog](https://www.flowlog-rs.com/) engine and the [VLDB 2026 paper](https://arxiv.org/pdf/2511.00865) by Hangdong Zhao, Zhenghong Yu, Srinag Rao, Simon Frisk, Zhiwei Fan and Paraschos Koutris.
- [`@electric-sql/d2ts`](https://github.com/electric-sql/d2ts) and [Tanstack DB](https://tanstack.com/db) for the dataflow primitives.
