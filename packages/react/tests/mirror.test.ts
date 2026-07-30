// What the store shows, versus what the engine emitted.
//
// The sink hands the store signed diffs, one per derivation, and the store
// folds them into the row set React reads. That fold looks trivial and isn't:
// a row with two derivations, one of which goes away, is emitted `-1` and `+1`
// in the *same* advance. Read as a per-tick net that is zero, and a row that is
// still perfectly well derived disappears from the UI.
//
// It showed up in the tutorial's incremental lesson — cutting one of two paths
// to a page dropped every page behind it — and it is invisible in a batch
// harness that accumulates over the whole run, which is why the engine's own
// suite never saw it. So the tests here drive a *session*: advance, assert,
// advance again.

import { describe, expect, it } from 'vitest'
import { parseProgram } from 'flow-ts'
import { Store } from '../src/index.js'
import type { Row } from 'flow-ts'

const REACH = `\
.in
.decl Link(from: string, to: string)

.out
.decl Reach(from: string, to: string)
.decl FromHome(page: string)

Reach(a, b) :- Link(a, b).
Reach(a, c) :- Reach(a, b), Link(b, c).
FromHome(p) :- Reach("home", p).
`

//   home ─▶ docs ─▶ api ─▶ guide
//   home ─▶ blog ─▶ api
// `api` is reachable two ways, which is the whole point.
const LINKS: ReadonlyArray<readonly [string, string]> = [
  ['home', 'docs'],
  ['docs', 'api'],
  ['api', 'guide'],
  ['home', 'blog'],
  ['blog', 'api'],
]

function seeded(): Store {
  const store = new Store(parseProgram(REACH, { grammarSource: 'reach.dl' }))
  for (const link of LINKS) store.update('Link', [...link], +1)
  store.flush()
  return store
}

const shown = (store: Store, relation: string): string[] =>
  store
    .snapshot(relation)
    .map((row: Row) => row.join('|'))
    .sort()

describe('a row with more than one derivation', () => {
  it('survives losing one of them', () => {
    const store = seeded()
    expect(shown(store, 'FromHome')).toEqual(['api', 'blog', 'docs', 'guide'])

    // Retracts Reach(home, api) via docs and re-derives it via blog, both in
    // this one advance. The net for the tick is zero; the row is still live.
    store.update('Link', ['docs', 'api'], -1)
    store.flush()
    expect(shown(store, 'FromHome')).toEqual(['api', 'blog', 'docs', 'guide'])
  })

  it('goes away once the last one does', () => {
    const store = seeded()
    store.update('Link', ['docs', 'api'], -1)
    store.flush()
    store.update('Link', ['blog', 'api'], -1)
    store.flush()
    expect(shown(store, 'FromHome')).toEqual(['blog', 'docs'])
  })

  it('comes back when the support does', () => {
    const store = seeded()
    store.update('Link', ['docs', 'api'], -1)
    store.update('Link', ['blog', 'api'], -1)
    store.flush()
    expect(shown(store, 'FromHome')).toEqual(['blog', 'docs'])

    store.update('Link', ['docs', 'api'], +1)
    store.flush()
    expect(shown(store, 'FromHome')).toEqual(['api', 'blog', 'docs', 'guide'])
  })

  it('notifies subscribers only when the row set really changed', () => {
    const store = seeded()
    let notifications = 0
    store.subscribe('FromHome', () => notifications++)

    // Same row set before and after, so nothing to re-render for.
    store.update('Link', ['docs', 'api'], -1)
    store.flush()
    expect(notifications).toBe(0)

    store.update('Link', ['blog', 'api'], -1)
    store.flush()
    expect(notifications).toBe(1)
  })
})

describe('EDB rows are a set', () => {
  it('inserting the same row twice is one row, and one delete removes it', () => {
    const store = new Store(parseProgram(REACH, { grammarSource: 'reach.dl' }))
    store.update('Link', ['home', 'docs'], +1)
    store.update('Link', ['home', 'docs'], +1)
    store.flush()
    expect(shown(store, 'Link')).toEqual(['home|docs'])

    store.update('Link', ['home', 'docs'], -1)
    store.flush()
    expect(shown(store, 'Link')).toEqual([])
    expect(shown(store, 'FromHome')).toEqual([])
  })

  it('deleting a row that was never there changes nothing', () => {
    const store = seeded()
    store.update('Link', ['nowhere', 'else'], -1)
    store.flush()
    expect(shown(store, 'FromHome')).toEqual(['api', 'blog', 'docs', 'guide'])
  })
})

describe('a program swap', () => {
  it('rebuilds the row set rather than adding to the old multiplicities', () => {
    const store = seeded()
    expect(shown(store, 'FromHome')).toEqual(['api', 'blog', 'docs', 'guide'])

    // Same rules, rebuilt. The replay re-emits every derivation; counts left
    // over from the previous graph would make every row twice-derived, and a
    // subsequent retraction would then fail to remove anything.
    store.replaceProgram(parseProgram(REACH, { grammarSource: 'reach.dl' }))
    expect(shown(store, 'FromHome')).toEqual(['api', 'blog', 'docs', 'guide'])

    store.update('Link', ['home', 'docs'], -1)
    store.update('Link', ['home', 'blog'], -1)
    store.flush()
    expect(shown(store, 'FromHome')).toEqual([])
  })
})
