// End-to-end tests for string-typed columns: declare, insert, read,
// equality filter, self-join, and join carrying a string into the head.

import { describe, expect, it } from 'vitest'
import { parseProgram } from '@flow-ts/parsing'
import type { Row } from '@flow-ts/reading'
import { executeProgram, type IdbSink } from '../src/index.js'

function run(source: string, edbs: Record<string, Row[]>, sink: IdbSink): void {
  const program = parseProgram(source, { grammarSource: 'inline' })
  executeProgram(program, new Map(Object.entries(edbs)), {}, sink)
}

describe('executeProgram — string columns', () => {
  it('declare → insert → read round-trips both columns', () => {
    const seen: Row[] = []
    run(
      `\
.in
.decl Person(id: number, name: string)
.input Person.csv

.out
.decl Out(id: number, name: string)

.rule
Out(id, name) :- Person(id, name).
`,
      { Person: [[1, 'alice'], [2, 'bob'], [3, 'carol']] },
      (rel, row, diff) => {
        if (rel === 'Out' && diff > 0) seen.push([...row])
      },
    )
    seen.sort((a, b) => (a[0] as number) - (b[0] as number))
    expect(seen).toEqual([[1, 'alice'], [2, 'bob'], [3, 'carol']])
  })

  it('string equality filter against a literal selects matching rows', () => {
    const seen: number[] = []
    run(
      `\
.in
.decl Person(id: number, name: string)
.input Person.csv

.out
.decl Alice(id: number)

.rule
Alice(id) :- Person(id, "alice").
`,
      { Person: [[1, 'alice'], [2, 'bob'], [3, 'alice']] },
      (rel, row, diff) => {
        if (rel === 'Alice' && diff > 0) seen.push(row[0] as number)
      },
    )
    expect(seen.sort()).toEqual([1, 3])
  })

  it('self-join on a string column finds pairs sharing a name', () => {
    const pairs: Array<[number, number]> = []
    run(
      `\
.in
.decl Person(id: number, name: string)
.input Person.csv

.out
.decl Same(a: number, b: number)

.rule
Same(a, b) :- Person(a, n), Person(b, n).
`,
      {
        Person: [
          [1, 'alice'],
          [2, 'bob'],
          [3, 'alice'],
        ],
      },
      (rel, row, diff) => {
        if (rel === 'Same' && diff > 0) {
          pairs.push([row[0] as number, row[1] as number])
        }
      },
    )
    pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    // Each person joins with themselves and (for alice) with the other alice.
    expect(pairs).toEqual([
      [1, 1],
      [1, 3],
      [2, 2],
      [3, 1],
      [3, 3],
    ])
  })

  it('join carries a string column from one EDB into the head', () => {
    const seen: Array<[number, string]> = []
    run(
      `\
.in
.decl Person(id: number, name: string)
.input Person.csv

.decl Friend(a: number, b: number)
.input Friend.csv

.out
.decl FriendName(a: number, name: string)

.rule
FriendName(a, name) :- Friend(a, b), Person(b, name).
`,
      {
        Person: [
          [1, 'alice'],
          [2, 'bob'],
        ],
        Friend: [
          [10, 1],
          [10, 2],
          [20, 1],
        ],
      },
      (rel, row, diff) => {
        if (rel === 'FriendName' && diff > 0) {
          seen.push([row[0] as number, row[1] as string])
        }
      },
    )
    seen.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]))
    expect(seen).toEqual([
      [10, 'alice'],
      [10, 'bob'],
      [20, 'alice'],
    ])
  })

  it('strings containing the field delimiter join correctly', () => {
    // Round-trips a string with `,` through the join machinery — exercises
    // both the encoder/decoder and the splitEncoded fast path.
    const seen: Array<[number, string]> = []
    run(
      `\
.in
.decl Tag(id: number, label: string)
.input Tag.csv

.out
.decl Out(id: number, label: string)

.rule
Out(id, label) :- Tag(id, label).
`,
      { Tag: [[1, 'a,b,c'], [2, 'plain'], [3, 'back\\slash']] },
      (rel, row, diff) => {
        if (rel === 'Out' && diff > 0) {
          seen.push([row[0] as number, row[1] as string])
        }
      },
    )
    seen.sort((a, b) => a[0] - b[0])
    expect(seen).toEqual([
      [1, 'a,b,c'],
      [2, 'plain'],
      [3, 'back\\slash'],
    ])
  })

  it('arithmetic on a string column throws a clear error', () => {
    expect(() => {
      run(
        `\
.in
.decl Person(id: number, name: string)
.input Person.csv

.out
.decl Bad(name: string)

.rule
Bad(n + 1) :- Person(_, n).
`,
        { Person: [[1, 'alice']] },
        () => {},
      )
    }).toThrow(/non-numeric/i)
  })

  it('Min aggregation over a string column throws', () => {
    expect(() => {
      run(
        `\
.in
.decl Person(id: number, name: string)
.input Person.csv

.out
.decl MinName(name: string)

.rule
MinName(min n) :- Person(_, n).
`,
        { Person: [[1, 'alice'], [2, 'bob']] },
        () => {},
      )
    }).toThrow()
  })
})
