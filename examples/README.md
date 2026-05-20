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
