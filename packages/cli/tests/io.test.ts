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
    expect(rows[0]).toEqual([1n, 2n])
    expect(rows[1]).toEqual([3n, 4n])
    expect(rows[2]).toEqual([5n, 6n])
  })

  it('parses tab-separated rows', () => {
    const p = writeFacts('arc.tsv', '1\t2\n3\t4\n')
    const rows = readRows(p, '\t', 2)
    expect(rows).toEqual([[1n, 2n], [3n, 4n]])
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
    expect(evens.map((r) => r[0])).toEqual([0n, 2n, 4n])
    // peers = 2, id = 1: keep odd first columns.
    const odds = readRows(p, ',', 1, 1, 2)
    expect(odds.map((r) => r[0])).toEqual([1n, 3n, 5n])
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

  it('throws if the RelDecl has no input path', () => {
    const decl = new RelDecl(
      'Arc',
      [new Attribute('x', 'Integer')],
      null,
    )
    expect(() => readRowsForRelDecl(decl, tmpDir, ',')).toThrow(/no input path/)
  })
})
