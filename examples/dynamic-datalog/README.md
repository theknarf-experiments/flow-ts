# Vendored programs from `frankmcsherry/dynamic-datalog`

Three benchmarks from Frank McSherry's
[dynamic-datalog](https://github.com/frankmcsherry/dynamic-datalog)
repo, ported to the flow-ts dialect. We use them to keep flow-ts
honest on non-trivial Datalog workloads — recursive joins, stratified
negation, big input fact sets.

| Program | Source | Status |
|---|---|---|
| `galen.dl` | medical-ontology inference (transitive-closure-ish) | ported; sample data in `galen-sample/`, real data via skip-if-missing test |
| `crdt.dl` | Kleppmann's collaborative-text-editor CRDT | ported; sample data in `crdt-sample/`, real data via skip-if-missing test |
| `doop.md` | DOOP program-analysis | not yet ported — uses Souffle features (multi-head rules, `.type` aliases) that need translation |

## Translation conventions

Going from Souffle's dialect (what McSherry's `query.dl` files use) to
flow-ts's dialect was mostly mechanical:

- `?x` variables → bare identifiers `x`.
- `[ctr: number, node: number]` composite IDs → flat 2-tuple columns
  `(ctr, n)` (flow-ts doesn't have record types).
- `.input X(IO="file", filename="x.txt", delimiter=",")` →
  `.input x.txt` (the delimiter is passed to the CLI via `-d`).
- `.output X` → `.decl X(...)` under the `.out` section.
- Inline body disjunction `(a > b; (a = b, c > d))` → two same-head
  rules (flow-ts doesn't support body-level `;` disjunction).
- McSherry's "EDB also used as IDB" pattern (e.g. `p` both as input
  and as derivation head) → split into separate EDB `P` + derived
  `OutP`, matching the upstream FlowLog port.

## Running

Each program runs against a directory of fact files. Sample data is
checked into the repo; the full data lives in McSherry's repo at
`~/projects/dynamic-datalog/problems/<name>/input/` (after
`unzip input.zip`).

```bash
# Quick smoke against the vendored sample
pnpm -F @flow-ts/cli run build
node packages/cli/dist/bin.js \
  -p examples/dynamic-datalog/galen.dl \
  -f examples/dynamic-datalog/galen-sample
# CRDT data is space-delimited
node packages/cli/dist/bin.js \
  -p examples/dynamic-datalog/crdt.dl \
  -f examples/dynamic-datalog/crdt-sample \
  -d ' '
```

The CLI tests in `packages/cli/tests/dynamic-datalog.test.ts` run
both against the bundled samples (always), and against the full
McSherry data when it's available locally (skipped otherwise).
