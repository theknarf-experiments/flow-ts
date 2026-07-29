# @flow-ts/docs

The documentation site: a Tanstack Start SPA that runs the whole flow-ts engine
in the browser, so every example on it is live rather than a code block.

```bash
pnpm install
pnpm -F @flow-ts/docs run dev     # http://localhost:5173
```

## What's here

Two halves, both in the sidebar.

**The tutorial** (`/learn/<slug>`) is one lesson per language feature, ordered so
each lesson only uses what the ones before it introduced:

| # | Lesson | Documents |
|---|---|---|
| 1 | Facts and rules | `.decl`, `.in` / `.out`, the four column types incl. `any`, `:-`, projection, set semantics |
| 2 | Joins | multi-atom bodies, equijoin by shared variable, n-way joins |
| 3 | Filters | constants in atoms, the `_` wildcard, `= == != < <= > >=`, self-joins |
| 4 | Arithmetic | `+ - * / %`, head expressions, flat left-to-right evaluation, truncating division |
| 5 | Many rules, one relation | union, IDBs in rule bodies |
| 6 | Recursion | recursive rules, transitive closure, fixpoint evaluation |
| 7 | Negation | `!Atom`, safety, stratification |
| 8 | Aggregation | `count` / `sum` / `min` / `max`, implicit group-by |
| 9 | Incremental updates | retraction, incremental maintenance, non-monotonic fallout |
| 10 | Ad-hoc queries | `?-` query rules, one-off evaluation, `useAdHocQuery` |
| 11 | Writing back | writable views, `writableColumns`, `Resolution` |
| 11.1 | Inserting: `.put insert` | `defaults(…)`, `via R`, multi-rule heads |
| 11.2 | Aggregates: `.put spread` | `spread(min\|max)`, inverting `sum`, integer least-change |
| 11.3 | Joins and refusals | `.put into R`, `.put none`, ambiguous resolutions |

The last three are `subOf: 'write-back'` — one level of nesting, indented in the
sidebar and numbered *within* lesson 11 rather than after it, so the tutorial
reads as eleven steps one of which has three parts. Each takes one thing the
rules cannot determine on their own and shows both halves: what the annotation
buys, and what the engine says when it isn't there.

**The demos** are the same engine at a size the tutorial deliberately avoids:

- **`/friends`** — recursive reachability with a live-editable program, a
  schema-driven inspector, and one writable view.
- **`/vault`** — a markdown vault as a live notebook. Notes are lowered into
  facts, nine views are derived from them, and editing a view rewrites the
  markdown. Backward propagation at full size, across three pages.
- **`/text`** — Stewen's RGA-like list CRDT (§4.2.2) driving a textarea. Each
  keystroke is an immutable `Insert`, backspace a `Remove`, and the rendered
  text comes from walking the derived `ListElem` list. Two replicas plus a
  `SyncLink` that simulates a flaky network.
- **`/mvr`** — Stewen's MVR key-value store (§4.2.1) with the same two-replica
  setup. Concurrent writes to one key coexist as a set; a toggle flips to the
  causal-broadcast variant.

## How the tutorial is built

The lessons are **data**, in `src/lessons/lessons.ts`. One entry carries the
prose, the program, the seed facts, the feature list and the things worth
trying; `src/lessons/Lesson.tsx` is the single component that renders all of
them, and `src/routes/learn.$slug.tsx` is the single route. Adding a lesson is
adding an array entry — there is no page to design and no route to register.

Every lesson is executed against its seed facts by `tests/lessons.test.ts`,
which asserts the rows the prose claims: that projecting away a column collapses
two people aged 17 into one row, that `(25 + 4) * 2` is what `p + q * 2` means,
that `spread(min)` gives the odd unit to the lowest member. The write-back
lessons are checked in both directions — with each annotation and without it —
because half of what they teach is what the refusals mean. A change to the
engine that quietly changes an answer fails the build rather than turning a
lesson into a lie. The same file checks that between them the lessons still
cover the language, so a new grammar feature can't land undocumented.

```bash
pnpm -F @flow-ts/docs run test:unit   # the lessons' claims
pnpm -F @flow-ts/docs run test        # those, then the Playwright suite
```

## Look

Light and dark are two palettes of the same role-named tokens
(`src/index.css`), selected by `<html data-theme>`. The sidebar toggle cycles
system → light → dark; system is the default and follows `prefers-color-scheme`
live. An inline script in `<head>` (`src/theme.ts`) applies the stored choice
before first paint, which is the only way to avoid a flash of the wrong palette
on load.

Beyond that the styling is mostly restraint. A lesson page shows a program and
six or eight relations at once, and boxing each of them turns a set of small
facts into a wall of frames — so relations render as bare tables separated by
space and one hairline under the header, and the program gets a label and an
inset code block rather than a card. Cell inputs read as text until you hover
or focus them: a table you can happen to edit, rather than a form.

## The React glue

The store / collection / hook layer lives in
[`@flow-ts/react`](../react/README.md): `Store` wraps one `openSession`,
`Collection<T>` is a typed EDB handle, `useLiveQuery(store, idb)` subscribes to
an IDB head, `useWritableQuery` adds the write-back operations, and
`useAdHocQuery` runs a one-off program over the facts the store holds. Each
lesson and each demo holds its own `Store`, so their programs don't share state.

The program panel on every page is live-editable: change a rule, click rebuild,
and `Store.replaceProgram` captures the current EDB rows, opens a fresh session
against the new rules and replays them. Rule edits aren't incremental — the
graph rebuilds from scratch — but the facts survive, which is what makes "edit
this rule and see what happens" a reasonable thing to ask a reader to do.

## Tanstack Start notes

SPA-only: `vite.config.ts` opts in with `spa: { enabled: true }`, so the build
prerenders a `_shell.html` and the client hydrates the full document. There is
no server runtime — the demo holds a stateful db-ivm session that doesn't
serialise. `src/routes/__root.tsx` sets `data-hydrated="true"` on `<body>` once
React mounts, which the e2e suite waits on before driving interactions.

We deliberately do *not* install the standalone `@tanstack/router-plugin/vite`:
Start already includes its own, and adding the standalone one on top runs the
code-splitter twice over the same route files and trips a duplicate-`hot`
declaration during HMR. Playwright therefore runs against the production
preview, which is unaffected and also what users actually deploy.

## Bundle size

```
dist/client/assets/index-*.css     16.33 kB    3.7 kB gzipped
dist/client/assets/index-*.js     301.78 kB   99.6 kB gzipped
```

That's the whole pipeline — parsing, stratification, planning, the db-ivm
operator runtime, the shadow compiler, Tanstack Router and Table, and the React
glue — in about 100 kB gzipped.
