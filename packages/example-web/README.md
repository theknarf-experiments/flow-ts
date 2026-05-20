# @flow-ts/example-web

A small React + Vite demo showing flow-ts running in the browser, with a Tanstack-DB-inspired "one collection, many live-query hooks" pattern.

## Run it

```bash
pnpm install
pnpm -F @flow-ts/example-web run dev
```

Open http://localhost:5173.

## What's here

A `Store` wraps one `openSession` from `@flow-ts/executing`. `Collection<T>` is a typed handle to an EDB you can `insert` / `delete` rows on. `useLiveQuery(store, idbName)` is a React hook that subscribes to an IDB head and re-renders the component whenever its row set changes.

Two bespoke panels in the demo each subscribe through their own `useLiveQuery` — one all-nodes list with reachability highlighting + headline stats, and one pure-reachable list. Underneath them sits a generic `<RelationTable>` (one instance per declared relation), which derives its columns from the program's `.decl` and renders through `@tanstack/react-table` for free sortable headers. Edits made in any panel — including row-level deletes and the inline add-row that EDB tables grow at the bottom — ripple through the underlying Datalog program and update the rest incrementally.

The Datalog program (`src/program.ts`) is a tiny reachability example:

```datalog
.decl Node(id: number)
.decl Source(id: number)
.decl Edge(src: number, dst: number)

.decl Reach(id: number)

Reach(y) :- Source(y).
Reach(z) :- Reach(y), Edge(y, z).
```

## API sketch

```ts
import { Store, useLiveQuery } from './lib/store.js'
import { program } from './program.js'

// One store per app.
const store = new Store(program)

// Typed EDB handles.
const nodes = store.collection<readonly [number]>('Node')
const edges = store.collection<readonly [number, number]>('Edge')

nodes.insert([1])
edges.insert([1, 2])

// In any React component:
function ReachableCount() {
  const reachable = useLiveQuery<readonly [number]>(store, 'Reach')
  return <span>{reachable.length} reachable</span>
}
```

Updates auto-batch via a microtask flush — a flurry of writes produces a single render, not one per row.

## Bundle size

```
dist/index.html                  0.42 kB
dist/assets/index-*.css          4.89 kB
dist/assets/index-*.js         297.86 kB    88.7 kB gzipped
```

That's the whole flow-ts pipeline — parsing, stratification, planning, the db-ivm operator runtime, Tanstack Table, and the React glue — in ~89 kB gzipped.
