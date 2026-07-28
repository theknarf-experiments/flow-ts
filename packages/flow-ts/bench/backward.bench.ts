// What backward propagation costs.
//
// Four questions, roughly in order of how much they'd change the design if the
// answer were bad:
//
//   1. What do shadow rules cost when you never use them? They sit in the graph
//      whether or not anyone writes, so this is the tax on every reader.
//   2. Does a request cost the delta or the database? This is the claim the
//      whole shadow-rules approach rests on.
//   3. What do the protocol's stages cost — propose, verify, minimise?
//   4. How does it scale with program size, not just data size?
//
// Nothing here asserts. Timings on a shared machine are noise, and a benchmark
// that fails the build teaches you about the machine rather than the code.

import { it } from 'vitest'
import { parseProgram } from '@flow-ts/parsing'
import { executeProgram, openSession } from '../src/executing/index.js'
import type { Row } from '../src/reading/index.js'
import { compileShadow, openBackwardSession, resolveBackward } from '../src/shadow/index.js'
import { fmt, ratio, table, time } from './_harness.js'

const PARSE = { parse: (src: string) => parseProgram(src, { grammarSource: 'shadow.dl' }), views: 'all' as const }

// A flow-md-shaped program: a parsed markdown tree, a view over it, and however
// many further views the caller wants stacked on top.
function vault(extraViews: number): string {
  const views = Array.from(
    { length: extraViews },
    (_, i) => `.decl V${i}(p: string, t: string)`,
  ).join('\n')
  const rules = Array.from(
    { length: extraViews },
    (_, i) => `V${i}(p, t) :- Open(p, t), MdNode(p, ${i}, "task-open", l).`,
  ).join('\n')
  return `\
.in
.decl MdNode(path: string, id: number, kind: string, line: number)
.input MdNode.csv
.decl MdNodeText(path: string, id: number, text: string)
.input MdNodeText.csv

.printsize
.decl Task(path: string, status: string, text: string, line: number)
.decl Open(p: string, t: string)
${views}

.rule
Task(p, "open", t, l) :- MdNode(p, i, "task-open", l), MdNodeText(p, i, t).
Open(p, t) :- Task(p, "open", t, l).
${rules}
`
}

/** `n` tasks spread over `n / 20` files, as a vault of that size would be. */
function facts(n: number): Record<string, Row[]> {
  const node: Row[] = []
  const text: Row[] = []
  for (let i = 0; i < n; i++) {
    const path = `note-${Math.floor(i / 20)}.md`
    node.push([path, i, 'task-open', i % 100])
    text.push([path, i, `task ${i}`])
  }
  return { MdNode: node, MdNodeText: text }
}

const load = (program: ReturnType<typeof parseProgram>, f: Record<string, Row[]>) => {
  const s = openSession(program, {}, () => {})
  for (const [rel, rows] of Object.entries(f)) for (const r of rows) s.update(rel, r, 1)
  s.advance()
  return s
}

const countRules = (src: string): number =>
  src.slice(src.indexOf('.rule')).split('\n').filter((l) => l.trim().endsWith('.')).length

it('1. what shadow rules cost when nobody writes', () => {
  const rows: string[][] = []
  for (const n of [200, 1000, 4000]) {
    const f = facts(n)
    const plainSrc = vault(0)
    const plain = parseProgram(plainSrc, { grammarSource: 'v.dl' })
    const shadowSrc = compileShadow(plain).source
    const shadow = parseProgram(shadowSrc, { grammarSource: 's.dl' })

    const loadPlain = time(() => void load(plain, f), { trials: 3, warmup: 1 })
    const loadShadow = time(() => void load(shadow, f), { trials: 3, warmup: 1 })

    // Steady state: one more fact, then advance. This is what a vault does on
    // every keystroke that changes a parse, and it is the cost that matters
    // most — it is paid continuously, by readers who never write.
    const stepPlain = time(
      () => {
        const s = load(plain, f)
        s.update('MdNode', ['extra.md', 999999, 'task-open', 1], 1)
        s.advance()
      },
      { trials: 3, warmup: 1 },
    )
    const stepShadow = time(
      () => {
        const s = load(shadow, f)
        s.update('MdNode', ['extra.md', 999999, 'task-open', 1], 1)
        s.advance()
      },
      { trials: 3, warmup: 1 },
    )

    rows.push([
      `${n} tasks`,
      fmt(loadPlain),
      fmt(loadShadow),
      ratio(loadShadow.median, loadPlain.median),
      fmt(stepPlain),
      fmt(stepShadow),
      ratio(stepShadow.median, stepPlain.median),
    ])
  }
  const plainSrc = vault(0)
  const shadowSrc = compileShadow(parseProgram(plainSrc, { grammarSource: 'v.dl' })).source
  table(
    `1. carrying shadow rules  (${countRules(plainSrc)} rules → ${countRules(shadowSrc)})`,
    ['size', 'load', 'load+shadow', 'x', 'load+step', '+shadow', 'x'],
    rows,
  )
})

it('1b. opting in narrows the tax', () => {
  const f = facts(2000)
  const src = vault(20)
  const program = parseProgram(src, { grammarSource: 'v.dl' })

  const variants: Array<[string, ReturnType<typeof compileShadow>]> = [
    ['every view, every channel', compileShadow(program)],
    ['every view, deletes only', compileShadow(program, { channels: ['del'] })],
    ['one view, every channel', compileShadow(program, { views: ['Open'] })],
    ['one view, rewrites only', compileShadow(program, { views: ['Open'], channels: ['upd'] })],
  ]

  const rows: string[][] = [
    ['no shadow rules at all', String(countRules(src)), fmt(time(() => void load(program, f), { trials: 3, warmup: 1 })), '1.0x'],
  ]
  const base = time(() => void load(program, f), { trials: 3, warmup: 1 }).median
  for (const [label, shadow] of variants) {
    const p = parseProgram(shadow.source, { grammarSource: 's.dl' })
    const t = time(() => void load(p, f), { trials: 3, warmup: 1 })
    rows.push([label, String(countRules(shadow.source)), fmt(t), ratio(t.median, base)])
  }
  table('1b. opting in (20 views, 2000 tasks)', ['built', 'rules', 'load', 'vs none'], rows)
})

it('2. does a request cost the delta or the database', () => {
  const program = parseProgram(vault(0), { grammarSource: 'v.dl' })
  const rows: string[][] = []
  for (const n of [200, 1000, 4000]) {
    const f = facts(n)
    const target: Row = ['note-0.md', 'task 1']

    const batch = time(
      () => void resolveBackward(program, f, { rel: 'Open', row: target }, PARSE),
      { trials: 3, warmup: 1 },
    )

    const s = openBackwardSession(program, PARSE)
    for (const [rel, rs] of Object.entries(f)) for (const r of rs) s.update(rel, r, 1)
    s.advance()
    const incremental = time(() => void s.propose({ rel: 'Open', row: target }), {
      n: 20,
      trials: 5,
    })
    s.close()

    rows.push([
      `${n} tasks`,
      fmt(batch),
      fmt(incremental),
      ratio(batch.median, incremental.median),
    ])
  }
  table('2. one request', ['size', 'batch', 'session', 'speedup'], rows)
})

it('3. what each stage of the protocol costs', () => {
  const program = parseProgram(vault(0), { grammarSource: 'v.dl' })
  const f = facts(1000)
  const target: Row = ['note-0.md', 'task 1']

  const s = openBackwardSession(program, PARSE)
  for (const [rel, rs] of Object.entries(f)) for (const r of rs) s.update(rel, r, 1)
  s.advance()

  const propose = time(() => void s.propose({ rel: 'Open', row: target }), { n: 20, trials: 5 })
  // resolve commits, so each measured call needs the previous one undone.
  const resolveOnce = (minimize: boolean) => {
    const sess = openBackwardSession(program, { ...PARSE, minimize })
    for (const [rel, rs] of Object.entries(f)) for (const r of rs) sess.update(rel, r, 1)
    sess.advance()
    const t = time(
      () => {
        sess.resolve({ rel: 'Open', row: target })
        // Put it back, so the next iteration has something to delete.
        sess.update('MdNode', ['note-0.md', 1, 'task-open', 1], 1)
        sess.update('MdNodeText', ['note-0.md', 1, 'task 1'], 1)
        sess.advance()
      },
      { n: 5, trials: 3 },
    )
    sess.close()
    return t
  }
  const resolve = resolveOnce(false)
  const minimized = resolveOnce(true)
  s.close()

  table(
    '3. protocol stages (1000 tasks)',
    ['stage', 'time', 'vs propose'],
    [
      ['propose only', fmt(propose), '1.0x'],
      ['resolve (propose+verify+commit)', fmt(resolve), ratio(resolve.median, propose.median)],
      ['resolve + minimise', fmt(minimized), ratio(minimized.median, propose.median)],
    ],
  )
})

it('4. scaling with program size', () => {
  const f = facts(500)
  const rows: string[][] = []
  for (const views of [0, 5, 20, 50]) {
    const src = vault(views)
    const program = parseProgram(src, { grammarSource: 'v.dl' })
    const shadowSrc = compileShadow(program).source

    const compile = time(
      () => {
        const p = parseProgram(src, { grammarSource: 'v.dl' })
        parseProgram(compileShadow(p).source, { grammarSource: 's.dl' })
      },
      { trials: 3, warmup: 1 },
    )
    const open = time(() => void openBackwardSession(program, PARSE), { trials: 3, warmup: 1 })

    const s = openBackwardSession(program, PARSE)
    for (const [rel, rs] of Object.entries(f)) for (const r of rs) s.update(rel, r, 1)
    s.advance()
    const request = time(
      () => void s.propose({ rel: 'Open', row: ['note-0.md', 'task 1'] }),
      { n: 10, trials: 3 },
    )
    s.close()

    rows.push([
      `${countRules(src)} rules`,
      `${countRules(shadowSrc)}`,
      fmt(compile),
      fmt(open),
      fmt(request),
    ])
  }
  table(
    '4. program size (500 tasks)',
    ['program', 'shadow rules', 'compile+parse', 'open session', 'request'],
    rows,
  )
})

it('5. forward evaluation is unchanged by any of this', () => {
  // A sanity check on the framing: batch evaluation of the original program is
  // what flow-ts did before any of this existed, and it should be untouched.
  const program = parseProgram(vault(0), { grammarSource: 'v.dl' })
  const rows: string[][] = []
  for (const n of [200, 1000, 4000]) {
    const f = facts(n)
    const t = time(
      () => executeProgram(program, new Map(Object.entries(f)), {}, () => {}),
      { trials: 3, warmup: 1 },
    )
    rows.push([`${n} tasks`, fmt(t), `${((t.median / n) * 1000).toFixed(1)}µs`])
  }
  table('5. plain batch evaluation', ['size', 'total', 'per task'], rows)
})
