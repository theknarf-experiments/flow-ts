// Targeted tests for the CSV reader.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Attribute, RelDecl } from '@flow-ts/parsing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readRows, readRowsForRelDecl } from '../src/io.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-ts-reading-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFacts(name: string, content: string): string {
  const filePath = path.join(tmpDir, name)
  fs.writeFileSync(filePath, content)
  return filePath
}

describe('readRows', () => {
  it('parses two-column rows separated by comma', () => {
    const p = writeFacts('arc.csv', '1,2\n3,4\n5,6\n')
    const rows = readRows(p, ',', 2)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual([1, 2])
    expect(rows[1]).toEqual([3, 4])
    expect(rows[2]).toEqual([5, 6])
  })

  it('parses tab-separated rows', () => {
    const p = writeFacts('arc.tsv', '1\t2\n3\t4\n')
    const rows = readRows(p, '\t', 2)
    expect(rows).toEqual([[1, 2], [3, 4]])
  })

  it('skips empty trailing lines', () => {
    const p = writeFacts('arc.csv', '1,2\n3,4\n\n')
    const rows = readRows(p, ',', 2)
    expect(rows).toHaveLength(2)
  })

  it('throws when a row has the wrong arity', () => {
    const p = writeFacts('arc.csv', '1,2,3\n')
    expect(() => readRows(p, ',', 2)).toThrow(/expected 2 values/)
  })

  it('applies worker sharding via (id, peers) on the first column', () => {
    const p = writeFacts('arc.csv', '0\n1\n2\n3\n4\n5\n')
    // peers = 2, id = 0: keep even first columns.
    const evens = readRows(p, ',', 1, 0, 2)
    expect(evens.map((r) => r[0])).toEqual([0, 2, 4])
    // peers = 2, id = 1: keep odd first columns.
    const odds = readRows(p, ',', 1, 1, 2)
    expect(odds.map((r) => r[0])).toEqual([1, 3, 5])
  })
})

describe('readRowsForRelDecl', () => {
  it('resolves the input path against factsDir', () => {
    writeFacts('Arc.csv', '1,2\n3,4\n')
    const decl = new RelDecl(
      'Arc',
      [new Attribute('x', 'Integer'), new Attribute('y', 'Integer')],
      'Arc.csv',
    )
    const rows = readRowsForRelDecl(decl, tmpDir, ',')
    expect(rows).toHaveLength(2)
  })

  it('defaults to <name>.facts when no .input path is declared', () => {
    writeFacts('Arc.facts', '1\n2\n3\n')
    const decl = new RelDecl(
      'Arc',
      [new Attribute('x', 'Integer')],
      null,
    )
    const rows = readRowsForRelDecl(decl, tmpDir, ',')
    expect(rows).toEqual([[1], [2], [3]])
  })

  it('parses string columns as strings, not NaN', () => {
    writeFacts('Person.csv', '1,alice\n2,bob\n3,carol\n')
    const decl = new RelDecl(
      'Person',
      [new Attribute('id', 'Integer'), new Attribute('name', 'String')],
      'Person.csv',
    )
    const rows = readRowsForRelDecl(decl, tmpDir, ',')
    expect(rows).toEqual([
      [1, 'alice'],
      [2, 'bob'],
      [3, 'carol'],
    ])
    expect(typeof rows[0]![1]).toBe('string')
  })

  it('parses float columns preserving decimal precision', () => {
    writeFacts('Measure.csv', '1,3.14\n2,-0.5\n3,42\n')
    const decl = new RelDecl(
      'Measure',
      [new Attribute('id', 'Integer'), new Attribute('value', 'Float')],
      'Measure.csv',
    )
    const rows = readRowsForRelDecl(decl, tmpDir, ',')
    expect(rows).toEqual([
      [1, 3.14],
      [2, -0.5],
      [3, 42],
    ])
    expect(typeof rows[0]![1]).toBe('number')
  })

  it('throws on row arity mismatch', () => {
    writeFacts('Bad.csv', '1,2,3\n')
    const decl = new RelDecl(
      'Bad',
      [new Attribute('x', 'Integer'), new Attribute('y', 'Integer')],
      'Bad.csv',
    )
    expect(() => readRowsForRelDecl(decl, tmpDir, ',')).toThrow(/expected 2 values/)
  })
})
