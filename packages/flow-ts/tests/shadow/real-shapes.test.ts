// The rule shapes a real consumer writes, rather than the ones I imagined.
//
// Every generated program in `_gen.ts` came out of a generator I wrote, which
// samples a distribution I chose: atoms of one to three columns, two variables
// per type, placeholders one argument in ten. flow-md's markdown plugin does
// not look like that. `MdNode` has seven columns and a rule reads it twice with
// three placeholders each time, discriminating on a string constant in the
// middle:
//
//   Task(path, status, text, line) :-
//     MdNode(path, id, _, "listItem", line, _, _),
//     MdProp(path, id, "status", status),
//     MdNode(path, para, id, "paragraph", _, _, _),
//     MdNodeText(path, para, text).
//
// So this fuzzes those rules directly — the actual text, copied — over
// generated syntax trees and generated edit sequences, comparing the
// maintained graph against recomputation after every operation. A generator
// tuned to my own intuitions cannot find what my intuitions missed; the way
// round it is to use somebody else's program.

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parseProgram } from '../../src/parsing/index.js'
import { executeProgram, openSession } from '../../src/executing/index.js'
import type { Row } from '../../src/reading/index.js'
import { compileShadow, resolveBackward } from '../../src/shadow/index.js'

// Copied from flow-md's `packages/plugin-markdown/src/rules.ts` and its
// schema. Copied rather than imported: flow-ts cannot depend on a consumer,
// and pinning the text is the point — if it drifts there, this still tests the
// shape it had when it was the thing being checked.
const MARKDOWN = `\
.in
.decl MdNode(path: string, id: number, parent: number, type: string, line: number, start: number, end: number)
.input MdNode.csv
.decl MdNodeText(path: string, id: number, text: string)
.input MdNodeText.csv
.decl MdProp(path: string, id: number, key: string, value: string)
.input MdProp.csv
.decl MdPropNum(path: string, id: number, key: string, value: number)
.input MdPropNum.csv
.decl MdInlineTag(path: string, tag: string, line: number)
.input MdInlineTag.csv
.decl Frontmatter(path: string, key: string, value: string)
.input Frontmatter.csv

.printsize
.decl Heading(path: string, level: number, text: string, line: number)
.decl Task(path: string, status: string, text: string, line: number)
.decl Link(path: string, dst: string, kind: string)
.decl LinkLabel(path: string, dst: string, text: string, line: number)
.decl CodeBlock(path: string, lang: string, line: number)
.decl Tag(path: string, tag: string)

.rule
Heading(path, level, text, line) :-
   MdNode(path, id, _, "heading", line, _, _),
   MdPropNum(path, id, "depth", level),
   MdNodeText(path, id, text).
Task(path, status, text, line) :-
   MdNode(path, id, _, "listItem", line, _, _),
   MdProp(path, id, "status", status),
   MdNode(path, para, id, "paragraph", _, _, _),
   MdNodeText(path, para, text).
Link(path, dst, kind) :-
   MdNode(path, id, _, _, _, _, _),
   MdProp(path, id, "link", kind),
   MdProp(path, id, "url", dst).
LinkLabel(path, dst, text, line) :-
   MdNode(path, id, _, _, line, _, _),
   MdProp(path, id, "link", _),
   MdProp(path, id, "url", dst),
   MdNodeText(path, id, text).
CodeBlock(path, lang, line) :-
   MdNode(path, id, _, "code", line, _, _),
   MdProp(path, id, "lang", lang),
   lang != "datalog",
   lang != "datalog-query".
Tag(path, tag) :- MdInlineTag(path, tag, _).
Tag(path, tag) :- Frontmatter(path, "tags", tag).
Tag(path, tag) :- Frontmatter(path, "tag", tag).
`
const PROGRAM = parseProgram(MARKDOWN, { grammarSource: 'md.dl' })
const VIEWS = ['Heading', 'Task', 'Link', 'LinkLabel', 'CodeBlock', 'Tag']
const parse = (src: string) => parseProgram(src, { grammarSource: 's.dl' })

type Facts = Record<string, Row[]>

const live = (m: Map<string, number>): string[] =>
  [...m].filter(([, n]) => n > 0).map(([k]) => k).sort()

function batch(facts: Facts): Map<string, string[]> {
  const counts = new Map<string, Map<string, number>>()
  executeProgram(PROGRAM, new Map(Object.entries(facts)), {}, (rel, row, diff) => {
    const m = counts.get(rel) ?? new Map<string, number>()
    const k = row.join(',')
    m.set(k, (m.get(k) ?? 0) + diff)
    counts.set(rel, m)
  })
  const out = new Map<string, string[]>()
  for (const view of VIEWS) out.set(view, live(counts.get(view) ?? new Map()))
  return out
}

// --- generated syntax trees -------------------------------------------------
//
// Shaped like what the parser emits, because the constants in the rules only
// discriminate if the data actually carries them: a node is a listItem or a
// paragraph or a heading, and a task needs an item whose child paragraph has
// text. Purely random rows would satisfy nothing and every view would be empty
// while coverage looked fine.

interface Node {
  kind: 'heading' | 'listItem' | 'paragraph' | 'code'
  id: number
  parent: number
  line: number
}

const nodeGen = fc.record({
  kind: fc.constantFrom('heading' as const, 'listItem' as const, 'paragraph' as const, 'code' as const),
  id: fc.integer({ min: 0, max: 5 }),
  parent: fc.integer({ min: 0, max: 5 }),
  line: fc.integer({ min: 1, max: 4 }),
})

const PATHS = ['a.md', 'b.md']
const TEXTS = ['one', 'two']

/** Lower generated nodes into the six source relations. */
function lower(nodes: readonly Node[], path: string): Facts {
  const f: Facts = {
    MdNode: [], MdNodeText: [], MdProp: [], MdPropNum: [], MdInlineTag: [], Frontmatter: [],
  }
  const seen = new Set<number>()
  for (const n of nodes) {
    if (seen.has(n.id)) continue
    seen.add(n.id)
    f.MdNode!.push([path, n.id, n.parent, n.kind, n.line, 0, 0])
    f.MdNodeText!.push([path, n.id, TEXTS[n.id % TEXTS.length]!])
    if (n.kind === 'heading') f.MdPropNum!.push([path, n.id, 'depth', (n.id % 3) + 1])
    if (n.kind === 'listItem') {
      f.MdProp!.push([path, n.id, 'status', n.id % 2 === 0 ? 'open' : 'closed'])
    }
    if (n.kind === 'code') {
      // Including the two langs the rule filters out, so the comparison is
      // exercised rather than always passing.
      f.MdProp!.push([path, n.id, 'lang', ['ts', 'datalog', 'datalog-query'][n.id % 3]!])
    }
    if (n.id % 2 === 0) {
      f.MdProp!.push([path, n.id, 'link', n.id % 4 === 0 ? 'wiki' : 'md'])
      f.MdProp!.push([path, n.id, 'url', `u${n.id % 2}`])
    }
    f.MdInlineTag!.push([path, `t${n.id % 2}`, n.line])
    f.Frontmatter!.push([path, n.id % 2 === 0 ? 'tags' : 'tag', `t${n.id % 2}`])
  }
  // Facts are a set. Two nodes can lower to the same Frontmatter or
  // MdInlineTag row — different ids, same key and value — and inserting one row
  // twice gives it multiplicity two, which no parser would ever produce and
  // which makes a retraction look like it did nothing.
  for (const [rel, rows] of Object.entries(f)) {
    const seenRow = new Set<string>()
    f[rel] = rows.filter((r) => {
      const k = r.join('\u0000')
      if (seenRow.has(k)) return false
      seenRow.add(k)
      return true
    })
  }
  return f
}

const treeGen = fc
  .tuple(fc.array(nodeGen, { minLength: 1, maxLength: 6 }), fc.constantFrom(...PATHS))
  .map(([nodes, path]) => lower(nodes, path))

/** Every fact, as (relation, row) pairs, for retracting one at random. */
const allRows = (f: Facts): Array<[string, Row]> =>
  Object.entries(f).flatMap(([rel, rows]) => rows.map((r) => [rel, r] as [string, Row]))

describe('the markdown plugin\'s own rules', () => {
  it('load and then retract, agreeing with recomputation at every step', () => {
    let checked = 0
    fc.assert(
      fc.property(treeGen, fc.array(fc.nat(), { minLength: 1, maxLength: 6 }), (facts, picks) => {
        const counts = new Map<string, Map<string, number>>()
        const session = openSession(PROGRAM, {}, (rel, row, diff) => {
          const m = counts.get(rel) ?? new Map<string, number>()
          const k = row.join(',')
          m.set(k, (m.get(k) ?? 0) + diff)
          counts.set(rel, m)
        })
        const remaining: Facts = Object.fromEntries(
          Object.entries(facts).map(([rel, rows]) => [rel, [...rows]]),
        )
        for (const [rel, rows] of Object.entries(facts)) {
          for (const row of rows) session.update(rel, row, 1)
        }
        session.advance()

        const check = () => {
          const want = batch(remaining)
          for (const view of VIEWS) {
            const got = live(counts.get(view) ?? new Map())
            if (got.join('|') !== want.get(view)!.join('|')) {
              throw new Error(
                `${view} drifted\n  session:   ${got.join(' ')}\n` +
                  `  recompute: ${want.get(view)!.join(' ')}`,
              )
            }
          }
        }
        check()

        for (const pick of picks) {
          const rows = allRows(remaining)
          if (rows.length === 0) break
          const [rel, row] = rows[pick % rows.length]!
          remaining[rel] = remaining[rel]!.filter((r) => r.join() !== row.join())
          session.update(rel, row, -1)
          session.advance()
          checked++
          check()
        }
        session.close()
        return true
      }),
      { numRuns: 120 },
    )
    expect(checked).toBeGreaterThan(200)
  })

  it('and the generated trees actually populate the views', () => {
    // A generator producing rows that satisfy nothing would pass everything
    // above while testing an empty graph, so assert the views are reached.
    const reached = new Set<string>()
    fc.assert(
      fc.property(treeGen, (facts) => {
        for (const [view, rows] of batch(facts)) if (rows.length > 0) reached.add(view)
        return true
      }),
      { numRuns: 200 },
    )
    for (const view of VIEWS) expect([...reached]).toContain(view)
  })
})

describe('writing back through them', () => {
  it('every column reported writable resolves to a source fact', () => {
    const shadow = compileShadow(PROGRAM, { views: VIEWS })
    let exercised = 0
    fc.assert(
      fc.property(treeGen, fc.nat(), fc.nat(), (facts, whichView, whichRow) => {
        const rows = batch(facts)
        const views = VIEWS.filter((v) => (rows.get(v) ?? []).length > 0)
        if (views.length === 0) return true
        const view = views[whichView % views.length]!
        const cols = shadow.writableColumns[view] ?? []
        if (cols.length === 0) return true

        const all = rows.get(view)!
        const row = all[whichRow % all.length]!.split(',')
        const at = cols[whichRow % cols.length]!
        const typed: Row = row.map((c) => (/^-?\d+$/.test(c) ? Number(c) : c))
        const next = [...typed]
        next[at] = typeof typed[at] === 'number' ? (typed[at] as number) + 100 : `${typed[at]}~n`

        const r = resolveBackward(
          PROGRAM,
          facts,
          { rel: view, row: typed, newRow: next },
          { parse, views: [view] },
        )
        exercised++
        // Not every row can take every edit — a value shared by two rows of the
        // same view is the ordinary reason. What must never happen is a
        // proposal that names a fact which is not there.
        if (r.status !== 'ok') return true
        const present = new Set(
          Object.entries(facts).flatMap(([rel, rs]) => rs.map((x) => `${rel}|${x.join(',')}`)),
        )
        return r.changes.every((c) => present.has(`${c.rel}|${c.row.join(',')}`))
      }),
      { numRuns: 200 },
    )
    expect(exercised).toBeGreaterThan(50)
  })

  it('and an accepted rewrite actually produces the row it was asked for', () => {
    const shadow = compileShadow(PROGRAM, { views: VIEWS })
    let landed = 0
    fc.assert(
      fc.property(treeGen, fc.nat(), fc.nat(), (facts, whichView, whichRow) => {
        const rows = batch(facts)
        const views = VIEWS.filter((v) => (rows.get(v) ?? []).length > 0)
        if (views.length === 0) return true
        const view = views[whichView % views.length]!
        const cols = shadow.writableColumns[view] ?? []
        if (cols.length === 0) return true

        const all = rows.get(view)!
        const typed: Row = all[whichRow % all.length]!
          .split(',')
          .map((c) => (/^-?\d+$/.test(c) ? Number(c) : c))
        const at = cols[whichRow % cols.length]!
        const next = [...typed]
        // A value nothing else could collide with, so a failure is the
        // engine's rather than the fixture's.
        next[at] = typeof typed[at] === 'number' ? 9999 : 'zzz~unique'

        const r = resolveBackward(
          PROGRAM,
          facts,
          { rel: view, row: typed, newRow: next },
          { parse, views: [view] },
        )
        if (r.status !== 'ok') return true

        const after: Facts = Object.fromEntries(
          Object.entries(facts).map(([rel, rs]) => [rel, [...rs]]),
        )
        for (const c of r.changes) {
          after[c.rel] = after[c.rel]!.map((x) =>
            x.join() === c.row.join() ? (c.newRow as Row) : x,
          )
        }
        landed++
        return (batch(after).get(view) ?? []).includes(next.join(','))
      }),
      { numRuns: 200 },
    )
    expect(landed).toBeGreaterThan(20)
  })
})
