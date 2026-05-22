# flow-ts

A Datalog engine in TypeScript, built on top of incremental dataflow.

flow-ts is a port of the Rust [FlowLog](https://www.flowlog-rs.com/) engine (VLDB 2026) onto a vendored fork of [Tanstack's db-ivm](https://github.com/TanStack/db) (which is itself a fork of [`@electric-sql/d2ts`](https://github.com/electric-sql/d2ts) with the time/version machinery stripped out). It parses Datalog programs, stratifies and plans them, and executes them as a dataflow graph whose operators are inherently incremental: feed it new facts later and only the affected derivations re-run.

## What you can do with it

- Run a Datalog program against EDB fact files and write IDB outputs.
- Open a long-lived session, push EDB updates over time, observe IDB diffs as they happen — incrementally, without re-evaluating from scratch.
- Use the executor as a library from Node *or the browser* (the executor and reading packages have zero filesystem dependencies).

## Status

- 17 of 18 upstream FlowLog example programs match the Rust engine row-for-row on synthetic test data. The one mismatch (`cc.dl`) is a semantic divergence around how aggregation logs are written under recursion, not a bug.
- Datalog features supported: stratified recursion, negation, head arithmetic, `min`/`max`/`sum`/`count` aggregations, sideways info passing (SIP, `-O 1`), planning optimisation (`-O 2`).
- Property-based + integration tests in `packages/flow-ts/tests/`.

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

```
Usage: flow-ts [options]

A Datalog engine on top of incremental dataflow

Options:
  -p, --program <path>    path of the Datalog program
  -f, --facts <dir>       directory containing EDB fact files
  -c, --csvs <dir>        directory to write IDB CSV outputs into
  -d, --delimiter <char>  field delimiter for fact files (default: ",")
  --fat-mode              enable fat-row mode for arities > 8
  --no-sharing            disable transformation-output sharing across rules
  -w, --workers <n>       number of worker threads (informational)
  -O <level>              optimization level: 0=as-is, 1=sip, 2=planning,
                          3=sip + planning
  --stream                read incremental EDB updates from stdin (see below)
  -h, --help              display help
```

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

The executor is published-shaped (not on npm yet) as `flow-ts`. Two entry points:

### Batch — `executeProgram`

```ts
import { executeProgram } from 'flow-ts'
import { parseProgram } from '@flow-ts/parsing'

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
                  ast/         Typed AST (shared with parsing)
                  strata/      Kosaraju's SCC → stratified evaluation order
                  catalog/     Per-rule signatures, SIP rewriting, dependent atoms
                  optimizing/  Prim's MST join-order optimisation
                  planning/    Logical IR: TransformationFlow trees, head arithmetic
                  reading/     Row type, encoding, in-memory rels (no I/O)
                  executing/   Dataflow assembly + executor (executeProgram, openSession)
  parsing/      Datalog grammar (peggy) → parseProgram. Depends on flow-ts for the AST.
  db-ivm/       Vendored Tanstack db-ivm + a queue-based `iterate` operator
  cli/          flow-ts binary, argv parsing (commander+zod), fact CSV I/O
  react/        React bindings: Store / Collection / useLiveQuery
  example-web/  Tanstack-Start SPA demo (friend-graph, text CRDT, MVR k/v)
```

The executor compiles a parsed `Program` into a db-ivm dataflow graph, one stratum at a time. Recursive strata get a queue-driven `iterate` operator (defined in `packages/db-ivm/src/operators/iterate.ts`) that's the moral equivalent of differential-dataflow's `scope.iterative` but without the time-tracking machinery — operators are stateful, so each iteration's body sees only the new diff, and convergence is detected by db-ivm's standard "no pending work" loop.

Rows cross the dataflow boundary as comma-joined strings (`"1,2,3,"`) rather than `number[]`: db-ivm uses JS `Map` for its top-level indexes, which means object identity matters, but JS hashes strings natively. The string boundary sidesteps both that and `JSON.stringify`'s aversion to `bigint`. Inside operators we project columns at the string level when possible, falling back to `number[]` only for arithmetic / compare evaluation.

## Browser usage

`flow-ts` and the rest of the stack are filesystem-free, so the whole engine runs in the browser unchanged. There's a working React demo in `packages/example-web/` with a Tanstack-DB-inspired pattern: one `Store` wraps a session, `Collection<T>` is a typed EDB handle, and `useLiveQuery(store, idb)` is a React hook that subscribes to an IDB head. Multiple components can subscribe to the same store and re-render incrementally as you edit the EDBs.

```bash
pnpm -F @flow-ts/example-web run dev
```

The whole pipeline (parser, planner, db-ivm runtime, React glue) ships in ~74 kB gzipped.

## Tests

```bash
pnpm test                              # 367 unit + property + e2e tests
pnpm -F @flow-ts/cli test -- vs-rust   # diff TS output against the Rust binary
```

The vs-rust oracle runs each upstream `.dl` example through both the Rust `executing` binary (from the `dbflow` repo) and our TS CLI on identical synthetic facts, then compares IDB CSV outputs row-by-row. It auto-skips if the Rust binary isn't available on disk (or set `RUST_FLOWLOG` to override the path).

## Acknowledgements

- The Rust [FlowLog](https://www.flowlog-rs.com/) engine and the [VLDB 2026 paper](https://arxiv.org/pdf/2511.00865) by Hangdong Zhao, Zhenghong Yu, Srinag Rao, Simon Frisk, Zhiwei Fan and Paraschos Koutris.
- [`@electric-sql/d2ts`](https://github.com/electric-sql/d2ts) and [Tanstack DB](https://tanstack.com/db) for the dataflow primitives.
