# @flow-ts/react

React bindings for the flow-ts Datalog runtime — a Tanstack-DB-inspired
"one collection, many live-query hooks" pattern on top of
`@flow-ts/executing`.

## Install

```bash
pnpm add @flow-ts/react @flow-ts/parsing @flow-ts/executing @flow-ts/reading react
```

## API sketch

```ts
import { parseProgram } from '@flow-ts/parsing'
import { Store, useLiveQuery, useProgram } from '@flow-ts/react'

const program = parseProgram(`
  .in
  .decl Person(id: number, name: string)
  .decl Friend(a: number, b: number)

  .out
  .decl Reach(a: number, b: number)

  Reach(x, y) :- Friend(x, y).
  Reach(x, z) :- Reach(x, y), Friend(y, z).
`)

const store = new Store(program)

// Typed EDB handles — column types follow the program's .decl.
const persons = store.collection<readonly [number, string]>('Person')
const friends = store.collection<readonly [number, number]>('Friend')

persons.insert([1, 'alice'])
friends.insert([1, 2])

// In any React component:
function ReachableCount() {
  const reach = useLiveQuery<readonly [number, number]>(store, 'Reach')
  return <span>{reach.length} pairs</span>
}
```

## How it works

`Store` wraps one long-lived `openSession` from `@flow-ts/executing`.
`Collection<T>(name)` is a typed handle to an EDB you can `insert` /
`delete` rows on. Each IDB head is materialised internally; the IDB
sink callback queues row diffs, and a microtask drives
`session.advance()` to a fixpoint and then notifies React subscribers
once per affected relation.

Updates auto-batch — `useLiveQuery` renders exactly once per microtask
no matter how many `insert` calls land in the same tick.

## Live program edits

`store.replaceProgram(newProgram)` swaps the running rules without
losing EDB state. It captures the authoritative per-relation row set,
closes the old session, opens a new one against the new program, and
replays every EDB row whose relation still exists. EDB rows for
relations that the new program drops stay parked — if a later edit
re-introduces the relation they come back automatically.

`useProgram(store)` re-renders on each swap so schema-driven UI
(inspectors, dynamic forms) picks up rule edits without bookkeeping.

The reload is not partial-graph patching — the new dataflow rebuilds
from scratch over the replayed EDBs. Fine for interactive demos, less
fine for big EDBs.
