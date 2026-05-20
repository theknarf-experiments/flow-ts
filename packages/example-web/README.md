# @flow-ts/example-web

A small React demo built on **Tanstack Start** (SPA mode — no SSR) showing flow-ts running in the browser, with a Tanstack-DB-inspired "one collection, many live-query hooks" pattern.

## Run it

```bash
pnpm install
pnpm -F @flow-ts/example-web run dev
```

Open http://localhost:5173.

## What's here

Two demos behind file-based routes:

- **`/friends`** — recursive reachability over a directed friend graph (`src/App.tsx` + `src/program.ts`).
- **`/text`** — Stewen's RGA-like list CRDT (`src/TextDemo.tsx` + `src/textProgram.ts`) driving a textarea: each keystroke becomes an immutable `Insert` op, backspace becomes a `Remove`, and the rendered text comes from walking the derived `ListElem` linked list.
- **`/`** — a small landing page linking to both.

The store / collection / hook glue lives in [`@flow-ts/react`](../react/README.md) — `Store` wraps one `openSession` from `@flow-ts/executing`, `Collection<T>` is a typed handle to an EDB you can `insert` / `delete` rows on, and `useLiveQuery(store, idbName)` is a React hook that subscribes to an IDB head and re-renders the component whenever its row set changes. Each route holds its own `Store` so the two programs don't share state.

The Tanstack Start setup is SPA-only: `vite.config.ts` opts in with `spa: { enabled: true }`, so the build prerenders a `_shell.html` and the client hydrates the full document. There's no server runtime — the demo holds a stateful db-ivm session that doesn't serialise. The root route in `src/routes/__root.tsx` sets `data-hydrated="true"` on `<body>` once React mounts, which the e2e suite waits on before driving interactions.

Two bespoke panels in the demo each subscribe through their own `useLiveQuery` — one People roster that flags who's reachable from "me" + headline stats, and one name-only "I can reach" list. Underneath them sits a generic `<RelationTable>` (one instance per declared relation), which derives its columns from the program's `.decl` and renders through `@tanstack/react-table` for free sortable headers. Edits made in any panel — including row-level deletes and the inline add-row that EDB tables grow at the bottom — ripple through the underlying Datalog program and update the rest incrementally.

The program panel at the top is **live-editable**: change a rule, click "rebuild", and `Store.replaceProgram` captures the current EDB rows, opens a fresh session against the new rules, and replays the EDBs against the new dataflow graph. Adding a new IDB rule surfaces a new table in the inspector immediately. Rule edits aren't incremental in the IVM sense — the graph rebuilds from scratch each time — but EDB state survives intermediate edits, so iterating on rules doesn't lose your inputs.

The Datalog program (`src/program.ts`) is a friend-graph reachability example with both numeric (ids) and string (names) columns:

```datalog
.decl Person(id: number, name: string)
.decl Me(id: number)
.decl Friend(a: number, b: number)

.decl Reach(a: number, b: number)
.decl ICanReach(name: string)

Reach(x, y) :- Friend(x, y).
Reach(x, z) :- Reach(x, y), Friend(y, z).

ICanReach(name) :- Me(me), Reach(me, id), Person(id, name).
```

## API sketch

```ts
import { Store, useLiveQuery } from './lib/store.js'
import { program } from './program.js'

// One store per app.
const store = new Store(program)

// Typed EDB handles — column types follow the program's .decl.
const persons = store.collection<readonly [number, string]>('Person')
const friends = store.collection<readonly [number, number]>('Friend')

persons.insert([1, 'alice'])
friends.insert([1, 2])

// In any React component:
function ReachableCount() {
  const reachable = useLiveQuery<readonly [string]>(store, 'ICanReach')
  return <span>{reachable.length} reachable</span>
}
```

Updates auto-batch via a microtask flush — a flurry of writes produces a single render, not one per row.

## Bundle size

```
dist/index.html                  0.42 kB
dist/assets/index-*.css          4.89 kB
dist/assets/index-*.js         301.42 kB    89.7 kB gzipped
```

That's the whole flow-ts pipeline — parsing, stratification, planning, the db-ivm operator runtime, Tanstack Table, and the React glue — in ~89 kB gzipped.
