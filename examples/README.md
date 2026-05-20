# flow-ts examples

Small `.dl` programs that exercise the engine's value-type system end to
end. Each program ships with its own CSV facts in this directory.

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
| [`stocks.dl`](stocks.dl) | `number`, `string`, `float` | Market-cap calculation: head arithmetic that multiplies a `float` price by an `integer` share count. Demonstrates that float and int interoperate in a single arithmetic expression. |
| [`mvr.dl`](mvr.dl) | `number`, `string` | Multi-value-register key-value store as a Datalog query (Stewen 2025, §4.2.1). An immutable log of `Set` operations plus a `Pred` causal-edge relation; the IDB `MvrStore` keeps every value not yet overwritten — concurrent winners coexist. |
| [`mvr_cb.dl`](mvr_cb.dl) | `number`, `string` | The same MVR store with **causal broadcast**: a `Set` op is only published once it's both a leaf of the causal graph *and* reachable from a root. The reachability check is a self-recursive `IsCausallyReady` IDB seeded from the roots. Drops ops whose causal predecessors haven't arrived yet. |
| [`list_crdt.dl`](list_crdt.dl) | `number`, `string` | A list CRDT (RGA-like causal-tree variant) as a Datalog query (Stewen 2025, §4.2.2). Twelve IDBs — `FirstChild`, `NextSibling`, `NextSiblingAnc`, `NextElem`, `HasValue`, `NextElemSkipTombstones`, `NextVisible`, `ListElem`, … — implement a depth-first pre-order traversal of the insertion tree, skipping tombstoned nodes. Seeded with the thesis's "HELLO!" example; walking the resulting linked list from `(0, 0)` reproduces the string. |
