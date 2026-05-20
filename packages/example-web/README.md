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

Four independent components in the demo each subscribe through their own `useLiveQuery` — one stats panel, one node list with reachability highlighting, one pure-reachable list, and one editor. Edits in any of them ripple through the underlying Datalog program and update the rest incrementally.

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
dist/assets/index-*.css          2.12 kB
dist/assets/index-*.js         243.17 kB    74 kB gzipped
```

That's the whole flow-ts pipeline — parsing, stratification, planning, the db-ivm operator runtime, and the React glue — in 74 kB gzipped.
