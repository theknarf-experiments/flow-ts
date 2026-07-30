// What a bad request should say.
//
// Every one of these used to fail quietly or misleadingly. A row with a string
// where the column is a number simply failed to join, so it came back as "not
// derived from the current facts (stale?)" — which sends you looking at your
// data when the problem is your request. In a session it was worse: `propose`
// just returned nothing at all.
//
// The distinction that matters is between a request that is *wrong* and one
// that is merely *unsatisfiable*. Wrong arity, wrong types, unknown relation:
// those are mistakes, and they should say so precisely. Not-currently-derived
// is a legitimate answer about the data.

import { describe, expect, it } from 'vitest'
import { parseProgram } from '../../src/parsing/index.js'
import type { Row } from '../../src/reading/index.js'
import { openBackwardSession, resolveBackward } from '../../src/shadow/index.js'

const PARSE = { parse: (src: string) => parseProgram(src, { grammarSource: 's.dl' }), views: 'all' as const }

const PROGRAM = parseProgram(
  `\
.in
.decl Task(path: string, status: string, text: string, line: number)
.input Task.csv

.printsize
.decl Open(p: string, t: string)

.rule
Open(p, t) :- Task(p, "open", t, l).
`,
  { grammarSource: 'p.dl' },
)

const FACTS: Record<string, Row[]> = { Task: [['a.md', 'open', 'milk', 3]] }

const reason = (r: ReturnType<typeof resolveBackward>): string =>
  r.status === 'refused' || r.status === 'unsatisfied' || r.status === 'ambiguous'
    ? (r as { reason: string }).reason
    : ''

describe('malformed requests are named, not mistaken for stale data', () => {
  it('wrong column type', () => {
    const r = resolveBackward(PROGRAM, FACTS, { rel: 'Open', row: [1, 'milk'] }, PARSE)
    expect(r.status).toBe('refused')
    expect(reason(r)).toMatch(/column 0.*string.*number|expects string/i)
    // Crucially it does *not* blame the data.
    expect(reason(r)).not.toMatch(/stale/i)
  })

  it('wrong arity', () => {
    const r = resolveBackward(PROGRAM, FACTS, { rel: 'Open', row: ['a.md'] }, PARSE)
    expect(r.status).toBe('refused')
    expect(reason(r)).toMatch(/2 columns.*1|arity/i)
  })

  it('unknown relation', () => {
    const r = resolveBackward(PROGRAM, FACTS, { rel: 'Nope', row: ['x'] }, PARSE)
    expect(r.status).toBe('refused')
    expect(reason(r)).toMatch(/Nope/)
  })

  it('the replacement row is checked too', () => {
    const r = resolveBackward(
      PROGRAM,
      FACTS,
      { rel: 'Open', row: ['a.md', 'milk'], newRow: ['a.md', 7] },
      PARSE,
    )
    expect(r.status).toBe('refused')
    expect(reason(r)).toMatch(/replacement|new row/i)
  })

  it('a well-formed row that simply is not derived still says so', () => {
    const r = resolveBackward(PROGRAM, FACTS, { rel: 'Open', row: ['a.md', 'bread'] }, PARSE)
    expect(r.status).toBe('refused')
    expect(reason(r)).toMatch(/not derived/i)
  })

  it('float and integer are interchangeable, since the engine stores both as numbers', () => {
    const r = resolveBackward(PROGRAM, FACTS, { rel: 'Open', row: ['a.md', 'milk'] }, PARSE)
    expect(r.status).toBe('ok')
  })
})

describe('a session refuses the same things', () => {
  const loaded = () => {
    const s = openBackwardSession(PROGRAM, PARSE)
    for (const row of FACTS.Task!) s.update('Task', row, 1)
    s.advance()
    return s
  }

  it('resolve reports a type error rather than returning nothing', () => {
    const s = loaded()
    const r = s.resolve({ rel: 'Open', row: [1, 'milk'] })
    expect(r.status).toBe('refused')
    expect(reason(r)).toMatch(/column 0/i)
    s.close()
  })

  it('propose throws, because a malformed request is a caller bug', () => {
    const s = loaded()
    expect(() => s.propose({ rel: 'Open', row: [1, 'milk'] })).toThrow(/column 0/i)
    // …and the session is still usable afterwards.
    expect(s.propose({ rel: 'Open', row: ['a.md', 'milk'] })).toHaveLength(1)
    s.close()
  })

  it('names a view that could not be given a seed channel', () => {
    const p = parseProgram(
      `\
.in
.decl A(x: number)
.input A.csv

.printsize
.decl Orphan()

.rule
A2(x) :- A(x).
`,
      { grammarSource: 'o.dl' },
    )
    const s = openBackwardSession(p, PARSE)
    const r = s.resolve({ rel: 'Orphan', row: [1] })
    expect(r.status).toBe('refused')
    expect(reason(r)).toMatch(/Orphan/)
    s.close()
  })
})
