// Writing back through a derived relation, from the React bindings.
//
// A `Store` has always been able to show derived rows and let you edit the
// *sources* behind them. What it couldn't do is let you edit the derived row
// itself and have the change land where it came from — which is the thing the
// shadow-rule work exists for.
//
// Two decisions are worth stating, because they are not the obvious ones.
//
// It is **opt-in per view**. Shadow rules force joins on their sources, which
// roughly doubles ordinary forward maintenance whether or not anyone writes
// (`pnpm bench`). A UI reads constantly and writes occasionally, so paying that
// continuously would be exactly the wrong trade.
//
// And it resolves **per edit**, with `resolveBackward`, rather than holding a
// maintained backward session. That costs more per write and nothing at all per
// read, which matches how a UI behaves; it scopes itself to the relation being
// edited; and it works on recursive programs, which a maintained session
// refuses. The demo program here is recursive, so that last point is not
// hypothetical.

import { describe, expect, it } from 'vitest'
import { parseProgram } from '@flow-ts/parsing'
import { Store } from '../src/index.js'

const SOURCE = `\
.in
.decl Person(id: number, name: string)
.decl Me(id: number)
.decl Friend(a: number, b: number)

.out
.decl Reach(a: number, b: number)
.decl ICanReach(name: string)

Reach(x, y) :- Friend(x, y).
Reach(x, z) :- Reach(x, y), Friend(y, z).
ICanReach(name) :- Me(me), Reach(me, id), Person(id, name).
`

const program = () => parseProgram(SOURCE, { grammarSource: 'demo.dl' })

/** A store seeded with a small network: me → ann → bob. */
function seeded(writable: string[] = ['ICanReach']) {
  const store = new Store(program(), { writable })
  store.collection<[number, string]>('Person').insert([1, 'me'])
  store.collection<[number, string]>('Person').insert([2, 'ann'])
  store.collection<[number, string]>('Person').insert([3, 'bob'])
  store.collection<[number]>('Me').insert([1])
  store.collection<[number, number]>('Friend').insert([1, 2])
  store.collection<[number, number]>('Friend').insert([2, 3])
  store.flush()
  return store
}

const names = (store: Store) =>
  store.snapshot('ICanReach').map((r) => String(r[0])).sort()

describe('opting in', () => {
  it('a view is not writable unless it was listed', () => {
    const store = seeded([])
    expect(store.canWrite('ICanReach')).toBe(false)
    const r = store.updateRow('ICanReach', ['ann'], ['annie'])
    expect(r.status).toBe('refused')
    if (r.status === 'refused') expect(r.reason).toMatch(/not writable|writable/i)
  })

  it('and is once it has been', () => {
    const store = seeded(['ICanReach'])
    expect(store.canWrite('ICanReach')).toBe(true)
    expect(store.canWrite('Reach')).toBe(false)
  })
})

describe('editing a derived row', () => {
  it('rewrites the source fact it came from', () => {
    const store = seeded()
    expect(names(store)).toEqual(['ann', 'bob'])

    const r = store.updateRow('ICanReach', ['ann'], ['annie'])
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    // The name lives on Person, two rules away and through a recursion.
    expect(r.changes).toEqual([
      { kind: 'upd', rel: 'Person', row: [2, 'ann'], newRow: [2, 'annie'] },
    ])

    store.flush()
    expect(names(store)).toEqual(['annie', 'bob'])
    // …and the change really is in the EDB, not just the view.
    expect(store.snapshot('Person')).toContainEqual([2, 'annie'])
  })

  it('reports a row that is not derived, rather than inventing one', () => {
    const store = seeded()
    const r = store.updateRow('ICanReach', ['nobody'], ['someone'])
    expect(r.status).toBe('refused')
    if (r.status === 'refused') expect(r.reason).toMatch(/not derived/i)
  })

  it('checks the shape of the request', () => {
    const store = seeded()
    const r = store.updateRow('ICanReach', [42], ['x'])
    expect(r.status).toBe('refused')
    if (r.status === 'refused') expect(r.reason).toMatch(/expects string/i)
  })

  it('leaves the store untouched when it refuses', () => {
    const store = seeded()
    const before = names(store)
    store.updateRow('ICanReach', ['nobody'], ['someone'])
    store.flush()
    expect(names(store)).toEqual(before)
  })
})

describe('removing a derived row', () => {
  it('cuts the smallest thing that achieves it', () => {
    const store = seeded()
    const r = store.removeRow('ICanReach', ['bob'], { minimize: true })
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    // Several things support "I can reach bob"; one is enough to cut.
    expect(r.changes).toHaveLength(1)

    store.flush()
    expect(names(store)).toEqual(['ann'])
  })

  it('surfaces ambiguity instead of guessing, when asked to', () => {
    const store = seeded()
    const r = store.removeRow('ICanReach', ['bob'], { requireUnambiguous: true })
    expect(r.status).toBe('ambiguous')
    if (r.status !== 'ambiguous') return
    expect(r.candidates.length).toBeGreaterThan(1)
    // Nothing was applied.
    store.flush()
    expect(names(store)).toEqual(['ann', 'bob'])
  })
})

describe('recursion', () => {
  it('works, because resolving recomputes rather than maintaining', () => {
    // `Reach` is recursive, and a maintained backward session refuses such a
    // program outright. Resolving per edit does not, which is the reason the
    // bindings resolve rather than maintain.
    const store = seeded()
    const r = store.updateRow('ICanReach', ['bob'], ['bobby'])
    expect(r.status).toBe('ok')
    store.flush()
    expect(names(store)).toEqual(['ann', 'bobby'])
  })
})

describe('reads are untouched', () => {
  it('no shadow rules are carried by a store that never writes', () => {
    // The store holds one forward session; the backward direction is compiled
    // on demand and thrown away. So `writable` costs nothing until it is used.
    const store = seeded([])
    expect(store.program.rules.length).toBe(program().rules.length)
    expect(names(store)).toEqual(['ann', 'bob'])
  })
})

describe('which columns are editable', () => {
  it('reports the view s writable columns, for rendering affordances', () => {
    const store = seeded()
    // `ICanReach(name) :- Me(me), Reach(me, id), Person(id, name).`
    // `name` is copied from Person and occurs once, so it can be rewritten.
    expect(store.writableColumns('ICanReach')).toEqual([0])
  })

  it('reports nothing for a view that was not opted in', () => {
    const store = seeded([])
    expect(store.writableColumns('ICanReach')).toEqual([])
  })

  it('distinguishes a copied column from one that is joined on', () => {
    const src = `\
.in
.decl Task(id: number, p: number)
.decl Person(p: number, name: string)

.out
.decl Listed(p: number, name: string)

Listed(p, n) :- Task(i, p), Person(p, n).
`
    const store = new Store(parseProgram(src, { grammarSource: 'j.dl' }), {
      writable: ['Listed'],
    })
    // `p` is the join key — rewriting it would have to change both sides.
    // `name` is copied from one position of one atom.
    expect(store.writableColumns('Listed')).toEqual([1])
  })

  it('the answer follows a program swap, since it depends on the rules', () => {
    const store = seeded()
    expect(store.writableColumns('ICanReach')).toEqual([0])
    store.replaceProgram(
      parseProgram(
        SOURCE.replace(
          'ICanReach(name) :- Me(me), Reach(me, id), Person(id, name).',
          'ICanReach(name) :- Me(me), Reach(me, id), Person(id, name), Person(id, name).',
        ),
        { grammarSource: 'demo.dl' },
      ),
    )
    // `name` now occurs in two atoms, so it is no longer a single-position copy.
    expect(store.writableColumns('ICanReach')).toEqual([])
  })
})

describe('resolving without applying', () => {
  it('returns the changes and leaves the store alone', () => {
    // What a consumer whose source of truth is a file needs: the engine says
    // which facts to change, and the file is what actually gets rewritten.
    const store = seeded()
    const r = store.updateRow('ICanReach', ['ann'], ['annie'], { dryRun: true })
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.changes).toEqual([
      { kind: 'upd', rel: 'Person', row: [2, 'ann'], newRow: [2, 'annie'] },
    ])
    store.flush()
    expect(names(store)).toEqual(['ann', 'bob'])
    expect(store.snapshot('Person')).toContainEqual([2, 'ann'])
  })
})

describe('policies for what the rules do not determine', () => {
  const SRC = `\
.in
.decl MdTask(path: string, line: number, text: string)

.out
.decl Task(path: string, text: string)

Task(p, t) :- MdTask(p, l, t).
`
  it('an insert is refused when nothing supplies the missing value', () => {
    const store = new Store(parseProgram(SRC, { grammarSource: 'a.dl' }), {
      writable: ['Task'],
    })
    const r = store.insertRow('Task', ['a.md', 'milk'])
    expect(r.status).toBe('refused')
    if (r.status === 'refused') expect(r.reason).toMatch(/value for "l"/)
  })

  it('and works once a policy supplies it', () => {
    // Better stated in the program with `.put insert defaults(l = 0)`; this is
    // the same thing for a program you don't own.
    const store = new Store(parseProgram(SRC, { grammarSource: 'a.dl' }), {
      writable: ['Task'],
      put: { Task: { kind: 'insert', via: null, defaults: [['l', { kind: 'Integer', value: 0 }]] } },
    })
    const r = store.insertRow('Task', ['a.md', 'milk'])
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.changes).toEqual([{ kind: 'ins', rel: 'MdTask', row: ['a.md', 0, 'milk'] }])
  })

  it('a `.put` directive in the program needs no options at all', () => {
    const store = new Store(
      parseProgram(SRC.replace('.decl Task(path: string, text: string)',
        '.decl Task(path: string, text: string)\n.put insert defaults(l = 0)'),
        { grammarSource: 'a.dl' }),
      { writable: ['Task'] },
    )
    expect(store.insertRow('Task', ['a.md', 'milk']).status).toBe('ok')
  })
})
