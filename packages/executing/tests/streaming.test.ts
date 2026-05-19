// Streaming session tests. Verifies that incremental updates produce the
// same net IDB state as a batch run, that retractions propagate, and that
// later inserts don't see stale state from earlier closed sessions.

import { describe, expect, it } from 'vitest'
import { parseProgram } from '@flow-ts/parsing'
import type { Row } from '@flow-ts/reading'
import { executeProgram, openSession, type IdbSink } from '../src/index.js'

const REACH_PROGRAM = `\
.in
.decl Source(id: number)
.input Source.csv

.decl Arc(x: number, y: number)
.input Arc.csv

.printsize
.decl Reach(id: number)

.rule
Reach(y) :- Source(y).
Reach(y) :- Reach(x), Arc(x, y).
`

function netRows(program: string, calls: Array<(s: ReturnType<typeof openSession>) => void>): Set<string> {
  const seen = new Map<string, number>()
  const sink: IdbSink = (rel, row, diff) => {
    const key = `${rel}|${row.map((v) => v.toString()).join(',')}`
    seen.set(key, (seen.get(key) ?? 0) + diff)
  }
  const session = openSession(
    parseProgram(program, { grammarSource: 'inline' }),
    {},
    sink,
  )
  for (const c of calls) c(session)
  session.close()
  const live = new Set<string>()
  for (const [key, n] of seen) if (n > 0) live.add(key)
  return live
}

describe('openSession — streaming basics', () => {
  it('streaming inserts converge to the same set as a batch run', () => {
    const batchSeen = new Set<string>()
    executeProgram(
      parseProgram(REACH_PROGRAM, { grammarSource: 'inline' }),
      new Map<string, Row[]>([
        ['Source', [[1]]],
        ['Arc', [[1, 2], [2, 3], [3, 4]]],
      ]),
      {},
      (rel, row, diff) => {
        if (diff <= 0) return
        batchSeen.add(`${rel}|${row.map((v) => v.toString()).join(',')}`)
      },
    )

    const streamLive = netRows(REACH_PROGRAM, [
      (s) => s.update('Source', [1]),
      (s) => s.update('Arc', [1, 2]),
      (s) => s.advance(),
      (s) => s.update('Arc', [2, 3]),
      (s) => s.advance(),
      (s) => s.update('Arc', [3, 4]),
      (s) => s.advance(),
    ])

    expect([...streamLive].sort()).toEqual([...batchSeen].sort())
  })

  it('one update per advance still converges', () => {
    const live = netRows(REACH_PROGRAM, [
      (s) => { s.update('Source', [1]); s.advance() },
      (s) => { s.update('Arc', [1, 2]); s.advance() },
      (s) => { s.update('Arc', [2, 3]); s.advance() },
      (s) => { s.update('Arc', [3, 4]); s.advance() },
    ])
    expect([...live].sort()).toEqual([
      'Reach|1', 'Reach|2', 'Reach|3', 'Reach|4',
    ])
  })

  it('retractions remove derived facts', () => {
    const live = netRows(REACH_PROGRAM, [
      // Same as the converging case
      (s) => {
        s.update('Source', [1])
        s.update('Arc', [1, 2])
        s.update('Arc', [2, 3])
        s.update('Arc', [3, 4])
        s.advance()
      },
      // Retract Arc(2, 3): Reach(3) and Reach(4) should go away
      (s) => {
        s.update('Arc', [2, 3], -1)
        s.advance()
      },
    ])
    expect([...live].sort()).toEqual(['Reach|1', 'Reach|2'])
  })

  it('throws when updating an unknown EDB', () => {
    const session = openSession(
      parseProgram(REACH_PROGRAM, { grammarSource: 'inline' }),
      {},
      () => {},
    )
    expect(() => session.update('NotAnEdb', [1])).toThrow(/unknown EDB/)
    session.close()
  })

  it('throws when updating after close', () => {
    const session = openSession(
      parseProgram(REACH_PROGRAM, { grammarSource: 'inline' }),
      {},
      () => {},
    )
    session.update('Source', [1])
    session.close()
    expect(() => session.update('Source', [2])).toThrow(/closed/)
  })

  it('emits +1 / -1 diffs through the sink for streaming retractions', () => {
    const events: Array<[string, string, number]> = []
    const session = openSession(
      parseProgram(REACH_PROGRAM, { grammarSource: 'inline' }),
      {},
      (rel, row, diff) => {
        events.push([rel, row.map((v) => v.toString()).join(','), diff])
      },
    )
    session.update('Source', [1])
    session.update('Arc', [1, 2])
    session.advance()
    session.update('Arc', [1, 2], -1)
    session.close()

    const reachEvents = events.filter(([rel]) => rel === 'Reach')
    // We should see both a +1 and a -1 for Reach(2) over the lifetime.
    const reach2 = reachEvents.filter(([, row]) => row === '2')
    expect(reach2.find(([, , d]) => d > 0)).toBeDefined()
    expect(reach2.find(([, , d]) => d < 0)).toBeDefined()
  })
})
