# flow-ts examples

Small `.dl` programs that exercise the engine's value-type system end to
end. Each program ships with its own CSV facts in this directory.

> **Looking for per-feature documentation?** That lives in the docs site
> (`pnpm -F @flow-ts/docs run dev`), as a tutorial of eleven lessons — one
> each for facts and rules, joins, filters, arithmetic, union, recursion,
> negation, aggregation, incremental retraction, ad-hoc queries and writing
> back, the last splitting into a part per `.put` policy — where every program
> is editable and every table is live. The files
> here are the CLI-facing set: whole programs at a realistic size, run against
> fact files, rather than one feature at a time. Neither duplicates the other.

## Running

From the repo root:

```bash
pnpm -F @flow-ts/cli run build
node packages/cli/dist/bin.js -p examples/<name>.dl -f examples
```

The CLI prints each derived IDB row to stdout. Pass `-c <dir>` to write
per-relation CSV files instead.

## What's here

| Program | Value types used | Highlights |
|---|---|---|
| [`friends.dl`](friends.dl) | `number`, `string` | Friend-of-friend resolved back to human-readable names; joins flow through a numeric edge relation but the head carries strings. |
| [`taxonomy.dl`](taxonomy.dl) | `string` only | Recursive transitive closure over a category hierarchy — every join key is a string. |
| [`payroll.dl`](payroll.dl) | `number`, `string` | The same aggregate written twice: declared, and as a `?-` query that brings its own head declaration. Plus two `?-` rules over one head (a union), and a bare `?- Body.` goal that reports the variables it binds under a generated name. |
| [`props.dl`](props.dl) | `string`, `any` | A property bag whose value column has no single type. An `any` cell keeps its JS type, joins a `string` column when it holds text, and takes part in arithmetic when it holds a number — and the number 1 does not match the string `"1"`. |
| [`stocks.dl`](stocks.dl) | `number`, `string`, `float` | Market-cap calculation: head arithmetic that multiplies a `float` price by an `integer` share count. Demonstrates that float and int interoperate in a single arithmetic expression. |
| [`mvr.dl`](mvr.dl) | `number`, `string` | Multi-value-register key-value store as a Datalog query (Stewen 2025, §4.2.1). An immutable log of `Set` operations plus a `Pred` causal-edge relation; the IDB `MvrStore` keeps every value not yet overwritten — concurrent winners coexist. |
| [`mvr_cb.dl`](mvr_cb.dl) | `number`, `string` | The same MVR store with **causal broadcast**: a `Set` op is only published once it's both a leaf of the causal graph *and* reachable from a root. The reachability check is a self-recursive `IsCausallyReady` IDB seeded from the roots. Drops ops whose causal predecessors haven't arrived yet. |
| [`list_crdt.dl`](list_crdt.dl) | `number`, `string` | A list CRDT (RGA-like causal-tree variant) as a Datalog query (Stewen 2025, §4.2.2). Twelve IDBs — `FirstChild`, `NextSibling`, `NextSiblingAnc`, `NextElem`, `HasValue`, `NextElemSkipTombstones`, `NextVisible`, `ListElem`, … — implement a depth-first pre-order traversal of the insertion tree, skipping tombstoned nodes. Seeded with the thesis's "HELLO!" example; walking the resulting linked list from `(0, 0)` reproduces the string. |
