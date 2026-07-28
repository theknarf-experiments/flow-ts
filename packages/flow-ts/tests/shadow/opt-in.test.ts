// Nobody pays for a shadow graph they didn't ask for.
//
// Shadow rules replay their rule's body, which forces joins — and therefore
// indexes — on relations the forward program never needed indexed that way.
// Measured on a flow-md-shaped program that roughly doubles ordinary forward
// maintenance, and that cost is paid continuously, by readers who never write.
// So scope is not a tuning knob to be left at its most expensive default.
//
// The two entry points want different things:
//
//   resolveBackward   compiles per request and throws the graph away, and it
//                     already knows which relation was asked about — so it
//                     scopes itself, and needs no configuration at all.
//   openBackwardSession  carries its graph for as long as it is open, so the
//                     scope is a standing cost and a real decision. It refuses
//                     to guess.

import { describe, expect, it } from 'vitest'
import { parseProgram } from '@flow-ts/parsing'
import type { Row } from '../../src/reading/index.js'
import { compileShadow, openBackwardSession, resolveBackward } from '../../src/shadow/index.js'
import type { Facts } from './_harness.js'

const PARSE = { parse: (src: string) => parseProgram(src, { grammarSource: 's.dl' }) }

const SRC = `\
.in
.decl Task(p: string, t: string)
.input Task.csv

.printsize
.decl Open(p: string, t: string)
.decl Other(p: string, t: string)
.decl Third(p: string, t: string)

.rule
Open(p, t) :- Task(p, t).
Other(p, t) :- Task(p, t).
Third(p, t) :- Task(p, t).
`
const PROGRAM = parseProgram(SRC, { grammarSource: 'p.dl' })
const FACTS: Facts = { Task: [['a.md', 'milk']] }

const channelsFor = (source: string): string[] =>
  [...new Set([...source.matchAll(/\b(?:Seed|SeedUpd|SeedIns)_(\w+)\(/g)].map((m) => m[1]!))].sort()

describe('resolveBackward scopes itself', () => {
  it('builds channels only for the relation being asked about', () => {
    // Not asserted through the public result — through what it compiles.
    const scoped = compileShadow(PROGRAM, { views: ['Open'] })
    expect(channelsFor(scoped.source)).toEqual(['Open'])
    const all = compileShadow(PROGRAM, { views: 'all' })
    expect(channelsFor(all.source)).toEqual(['Open', 'Other', 'Third'])
  })

  it('needs no configuration, and still works', () => {
    const r = resolveBackward(PROGRAM, FACTS, { rel: 'Open', row: ['a.md', 'milk'] }, PARSE)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.changes).toEqual([{ kind: 'del', rel: 'Task', row: ['a.md', 'milk'] }])
  })

  it('a caller can still widen it deliberately', () => {
    const r = resolveBackward(PROGRAM, FACTS, { rel: 'Other', row: ['a.md', 'milk'] }, {
      ...PARSE,
      views: 'all',
    })
    expect(r.status).toBe('ok')
  })
})

describe('openBackwardSession refuses to guess', () => {
  it('will not open without a scope', () => {
    expect(() => openBackwardSession(PROGRAM, PARSE)).toThrow(/views/i)
  })

  it('says why, and what to pass', () => {
    try {
      openBackwardSession(PROGRAM, PARSE)
      expect.unreachable()
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toMatch(/doubles forward maintenance/i)
      expect(msg).toMatch(/views: 'all'/)
    }
  })

  it('opens with a narrow scope, and refuses requests outside it', () => {
    const s = openBackwardSession(PROGRAM, { ...PARSE, views: ['Open'] })
    s.update('Task', ['a.md', 'milk'] as Row, 1)
    s.advance()

    expect(s.resolve({ rel: 'Open', row: ['a.md', 'milk'] }).status).toBe('ok')

    const other = s.resolve({ rel: 'Other', row: ['a.md', 'milk'] })
    expect(other.status).toBe('refused')
    if (other.status === 'refused') {
      expect(other.reason).toMatch(/no seed channel/i)
    }
    s.close()
  })

  it('opens with everything when that is what the caller wants', () => {
    const s = openBackwardSession(PROGRAM, { ...PARSE, views: 'all' })
    s.update('Task', ['a.md', 'milk'] as Row, 1)
    s.advance()
    expect(s.resolve({ rel: 'Other', row: ['a.md', 'milk'] }).status).toBe('ok')
    s.close()
  })
})

describe('channels are separable too', () => {
  it('a consumer that only rewrites cells builds no delete channel', () => {
    const upd = compileShadow(PROGRAM, { views: ['Open'], channels: ['upd'] })
    expect(upd.source).toContain('SeedUpd_Open')
    expect(upd.source).not.toContain('.decl Seed_Open(')
    expect(upd.source).not.toContain('SeedIns_Open')
  })

  it('and the rules behind the unused channels go with them', () => {
    const all = compileShadow(PROGRAM, { views: 'all' })
    const one = compileShadow(PROGRAM, { views: ['Open'], channels: ['upd'] })
    const count = (src: string) =>
      src.slice(src.indexOf('.rule')).split('\n').filter((l) => l.trim().endsWith('.')).length
    expect(count(one.source)).toBeLessThan(count(all.source) / 3)
  })
})
