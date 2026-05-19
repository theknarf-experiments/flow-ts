// Integration test wiring a db-ivm graph with our Rel + InputSession.

import { D2, MultiSet, map, output } from '@flow-ts/db-ivm'
import { describe, expect, it } from 'vitest'
import { InputSessionGeneric, Rel, type Row } from '../src/index.js'

describe('Rel + InputSession (integration)', () => {
  it('feeds rows through a db-ivm pipeline and surfaces them via output()', () => {
    const graph = new D2()
    const input = graph.newInput<Row>()
    const arc = new Rel(input, 2)
    const session = new InputSessionGeneric<Row>(2, input)

    // Build a tiny pipeline: just project to the second column.
    const seen: bigint[] = []
    arc.stream.pipe(
      map((row) => row[1]!),
      output((data) => {
        for (const [v] of data.getInner()) {
          seen.push(v)
        }
      }),
    )

    graph.finalize()

    for (const row of [[1n, 2n], [3n, 4n], [5n, 6n]] as Row[]) {
      session.update(row, 1)
    }
    session.flush()
    graph.run()

    expect(seen.sort()).toEqual([2n, 4n, 6n])
  })

  it('Rel.threshold dedupes rows of equal content', () => {
    const graph = new D2()
    const input = graph.newInput<Row>()
    const rel = new Rel(input, 1)

    const seen: bigint[] = []
    rel
      .threshold()
      .stream.pipe(
        output((data) => {
          for (const [row, mult] of data.getInner()) {
            for (let i = 0; i < mult; i++) seen.push(row[0]!)
          }
        }),
      )

    graph.finalize()

    // Push (1) twice and (2) once — distinct should report each row once.
    input.sendData(
      new MultiSet<Row>([
        [[1n], 1],
        [[1n], 1],
        [[2n], 1],
      ]),
    )
    graph.run()

    expect(seen.sort()).toEqual([1n, 2n])
  })
})
