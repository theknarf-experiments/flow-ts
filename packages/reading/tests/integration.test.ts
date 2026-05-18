// Integration test wiring a d2ts graph with our Rel + InputSession + Reader.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { D2, MessageType, MultiSet, map, output } from '@electric-sql/d2ts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  InputSessionGeneric,
  Rel,
  readRows,
  type Row,
} from '../src/index.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-ts-reading-int-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('Rel + InputSession + Reader (integration)', () => {
  it('feeds CSV rows through a d2ts pipeline and surfaces them via output()', () => {
    const csvPath = path.join(tmpDir, 'arc.csv')
    fs.writeFileSync(csvPath, '1,2\n3,4\n5,6\n')

    const graph = new D2({ initialFrontier: 0 })
    const input = graph.newInput<Row>()
    const arc = new Rel(input, 2)
    const session = new InputSessionGeneric<Row>(2, input)

    // Build a tiny pipeline: just project to the second column.
    const seen: bigint[] = []
    arc.stream.pipe(
      map((row) => row[1]!),
      output((msg) => {
        if (msg.type !== MessageType.DATA) return
        for (const [v] of msg.data.collection.getInner()) {
          seen.push(v)
        }
      }),
    )

    graph.finalize()

    for (const row of readRows(csvPath, ',', 2)) {
      session.update(row, 1)
    }
    session.advanceTo(1)
    graph.run()

    expect(seen.sort()).toEqual([2n, 4n, 6n])
  })

  it('Rel.threshold dedupes rows of equal content', () => {
    const graph = new D2({ initialFrontier: 0 })
    const input = graph.newInput<Row>()
    const rel = new Rel(input, 1)

    const seen: bigint[] = []
    rel
      .threshold()
      .stream.pipe(
        output((msg) => {
          if (msg.type !== MessageType.DATA) return
          for (const [row, mult] of msg.data.collection.getInner()) {
            for (let i = 0; i < mult; i++) seen.push(row[0]!)
          }
        }),
      )

    graph.finalize()

    // Push (1) twice and (2) once — distinct should report each row once.
    input.sendData(
      0,
      new MultiSet<Row>([
        [[1n], 1],
        [[1n], 1],
        [[2n], 1],
      ]),
    )
    input.sendFrontier(1)
    graph.run()

    expect(seen.sort()).toEqual([1n, 2n])
  })
})
