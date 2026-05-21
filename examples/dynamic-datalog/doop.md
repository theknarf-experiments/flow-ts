# DOOP program-analysis benchmark — NOT YET PORTED

McSherry's [DOOP](../../../../dynamic-datalog/problems/doop) example
is a 561-line Datalog program that runs a fragment of the Doop
points-to analysis. It uses several Souffle features flow-ts doesn't
support out of the box:

- **Multi-head rules** — `a(x), b(x), c(x) :- p(x).` derives three
  facts (one per head atom) from each match of the body. flow-ts only
  permits a single head atom per rule. Translation: split each
  multi-head rule into N single-head rules sharing the same body.
- **`.type` aliases** — Souffle's user-defined types (`Var`, `Method`,
  `HeapAllocation`, …) eventually bottom out at `symbol` (Souffle's
  interned-string type). flow-ts has `string` and doesn't intern; we
  can drop the alias system and use `string` directly.
- **`?x` variable prefix** — Souffle's optional `?` prefix on
  variables. flow-ts uses bare identifiers; drop the `?`.
- **`symbol`** — interned string. Maps to flow-ts `string`.
- **`.input X(IO="file", filename="Y.facts", delimiter="\t")`** — pass
  `-d '\t'` to the CLI and use `.input Y.facts` in the program.

The translation is mechanical but the program is 561 lines with 105+
declarations and many multi-head rules. Plus the data unzips to ~2GB
of fact files, so a CI-friendly test would have to use a subset or
skip-if-missing entirely.

Open work item; not currently in the test suite.
