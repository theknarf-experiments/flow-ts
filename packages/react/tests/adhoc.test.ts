import { describe, expect, it } from 'vitest'
import { parseProgram } from 'flow-ts'
import { Store } from '../src/index.js'

// A query the program has never seen, over the facts the store holds.
//
// `useLiveQuery` reads a relation the program declares. A console's query has
// no such relation — it did not exist when the graph was built — so it is
// evaluated in a throwaway. What matters is *where the facts come from*: a
// consumer left to itself re-derives them from whatever it parsed the project
// from, and can then only see what came from that source. A store holds
// relations that were never in a file.
const SOURCE = `\
.in
.decl CssVar(path: string, id: number, name: string, value: string)
.input CssVar.csv
.decl Frame(id: string, name: string)
.input Frame.csv

.printsize
.decl Token(path: string, name: string)

.rule
Token(p, n) :- CssVar(p, i, n, v).
`

function seeded() {
  const store = new Store(parseProgram(SOURCE, { grammarSource: 'a.dl' }))
  store.collection('CssVar').insert(['/a.css', 0, '--brand', '#06f'] as never)
  store.collection('CssVar').insert(['/a.css', 1, '--gap', '8px'] as never)
  // Put straight into the store, as a canvas or a poll would — never parsed
  // from a file, and invisible to anything that re-derives from files.
  store.collection('Frame').insert(['f1', 'Home'] as never)
  store.flush()
  return store
}

describe('running a program the store has never seen', () => {
  it('answers over the facts it holds', () => {
    const r = seeded().runAdHoc(
      '.printsize\n.decl Q(name: string)\n\n.rule\nQ(n) :- CssVar(p, i, n, v).\n',
    )
    expect(r.error).toBeNull()
    expect([...(r.rows.get('Q') ?? [])].map((x) => x[0]).sort()).toEqual(['--brand', '--gap'])
  })

  it('including relations that were never in a file', () => {
    // The reason for reading the store rather than re-parsing.
    const r = seeded().runAdHoc('.printsize\n.decl Q(n: string)\n\n.rule\nQ(n) :- Frame(i, n).\n')
    expect(r.error).toBeNull()
    expect([...(r.rows.get('Q') ?? [])].map((x) => x[0])).toEqual(['Home'])
  })

  it('and joins across both', () => {
    const r = seeded().runAdHoc(
      '.printsize\n.decl Q(f: string, n: string)\n\n.rule\nQ(f, n) :- Frame(i, f), CssVar(p, j, n, v).\n',
    )
    expect(r.error).toBeNull()
    expect((r.rows.get('Q') ?? []).length).toBe(2)
  })

  it('leaves the source relations out of the answer', () => {
    const r = seeded().runAdHoc('.printsize\n.decl Q(n: string)\n\n.rule\nQ(n) :- Frame(i, n).\n')
    expect([...r.rows.keys()]).toEqual(['Q'])
  })

  it('reports a parse error rather than throwing', () => {
    const r = seeded().runAdHoc('.printsize\n.decl Q(n: string)\n\n.rule\nQ(n) :- nonsense(\n')
    expect(r.error).toBeTruthy()
    expect(r.rows.size).toBe(0)
  })

  it('and an evaluation error the same way', () => {
    // An unbound head variable is a rule the engine will not run.
    const r = seeded().runAdHoc('.printsize\n.decl Q(n: string)\n\n.rule\nQ(z) :- Frame(i, n).\n')
    expect(r.error).toBeTruthy()
  })

  it('sees a fact added after the store was built', () => {
    const store = seeded()
    const before = store.runAdHoc('.printsize\n.decl Q(n: string)\n\n.rule\nQ(n) :- Frame(i, n).\n')
    store.collection('Frame').insert(['f2', 'About'] as never)
    store.flush()
    const after = store.runAdHoc('.printsize\n.decl Q(n: string)\n\n.rule\nQ(n) :- Frame(i, n).\n')
    expect((before.rows.get('Q') ?? []).length).toBe(1)
    expect([...(after.rows.get('Q') ?? [])].map((x) => x[0]).sort()).toEqual(['About', 'Home'])
  })

  it('and a retraction', () => {
    const store = seeded()
    store.collection('Frame').delete(['f1', 'Home'] as never)
    store.flush()
    const r = store.runAdHoc('.printsize\n.decl Q(n: string)\n\n.rule\nQ(n) :- Frame(i, n).\n')
    expect(r.rows.get('Q')).toBeUndefined()
  })

  it('moves a version counter so a caller can tell facts changed', () => {
    const store = seeded()
    const v = store.edbVersion()
    store.collection('Frame').insert(['f3', 'Docs'] as never)
    store.flush()
    expect(store.edbVersion()).toBeGreaterThan(v)
  })
})
