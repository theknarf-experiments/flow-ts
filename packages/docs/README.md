# @flow-ts/docs

The documentation site: a Vite + React SPA that runs the whole flow-ts engine in
the browser, so every example on it is live rather than a code block.

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

## The stack

Vite, React and `react-router`. `index.html` is the dev entry, `src/routes.tsx`
is the route table, and `pnpm build` prerenders one HTML file per route.
(`@tanstack/react-table` stays — it's what gives the relation tables their
sortable headers, and has nothing to do with routing.)

## Static pages

`pnpm build` runs `./ssg.tsx` rather than `vite build`: a `vite-node` script that
walks the route table, renders each page with react-router's
`createStaticHandler`, and emits it as a Rollup chunk that Vite's own HTML
pipeline finishes. `build:spa` is still the plain single-`index.html` build.

The result is a directory of real files — `/learn/recursion/index.html` and so
on, plus a `404.html` — so a deep link needs no server rewrite, and the content
is there before any JavaScript runs. That last part is not just the prose: the
engine runs at build time, so a lesson's *derived tables* are in the HTML.
`e2e/static.spec.ts` checks that with scripting switched off entirely.

Two details are load-bearing and easy to lose, both learned from the repo this
was adapted from (`theknarf-experiments/modular-svg`):

- Each page carries `<base href>` set to Vite's `base`, so relative asset URLs
  resolve when published under a subpath.
- The static render uses the same router `basename` the client hydrates with, so
  the prerendered nav hrefs already carry that subpath. Without it, opening a
  sidebar link in a new tab on Pages 404s.

`DOCS_BASE` is what sets that base: `/` locally, `/flow-ts/` from the deploy
workflow. Everything that has to agree with it reads it from Vite rather than
repeating it.

**Known issue: hydration falls back to a client render.** On pages carrying a
relation table — the lessons, `/friends`, `/text`, `/mvr` — React reports a
hydration mismatch and re-renders the tree instead of adopting the markup. The
pages are correct either way and the whole suite passes; what is lost is the
work the prerender was supposed to save on load. `/` and the vault pages hydrate
cleanly. Two real mismatches were found and fixed on the way here (the theme
toggle reading `matchMedia` during render, and the brand `NavLink` computing
`active` differently under the static renderer); this is a third that has not
been pinned down. `SSG_DEV=1 pnpm build` builds against development React,
unminified, which is the only way to get a component name out of it.

Two things are worth knowing before editing it.

Everything below the shell is loaded with React Router's `lazy`, which is doing
real work rather than being a reflex: the overview needs no engine at all, and
each demo pulls its own program, seed data and — for the CRDTs — a simulated
network. Left eager they are one 530 kB chunk that every visitor downloads to
read a sentence about Datalog.

And the theme script is inline in `index.html`, not imported. A module script
runs after the stylesheet has been applied, so the page would paint in the
default palette and flip a frame later — which is the exact flash the script
exists to prevent. `src/theme.ts` holds the same logic for the runtime toggle
and the two are kept in step by hand.

`src/Shell.tsx` sets `data-hydrated="true"` on `<body>` once React mounts. The
e2e suite waits on it as a cheap "the app is up" signal.

## Bundle size

Per page, gzipped, from `pnpm build`:

```
overview (/)                 92.7 kB js   3.8 kB css
a lesson, or any demo       ~131 kB js   4.6 kB css
```

The difference is the engine — parsing, stratification, planning, the db-ivm
operator runtime, the shadow compiler — plus Tanstack Table, which are a shared
chunk fetched by the pages that actually run a program. The overview carries the
shell, the router and the tutorial index and nothing else.
