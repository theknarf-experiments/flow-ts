// Port of flowlog/src/reading/src/inspect.rs (the in-process printers only).
//
// File-output helpers (writeRel, writeRelSize, mergeRelationPartitions) live
// in `@flow-ts/cli`'s `io.ts` so this module stays browser-compatible.

import { distinct, map, output } from '@flow-ts/db-ivm'
import { type Rel, type DoubleRel } from './rel.js'
import { type Row, rowToString } from './row.js'

/** Attach a printer that reports the per-batch cardinality of `rel`. */
export function inspectSize<T extends Row>(
  rel: Rel<T>,
  name: string,
  isRecursive: boolean,
): void {
  const prefix = isRecursive
    ? `Delta of (recursive) ${name}`
    : `Size of (non-recursive) ${name}`
  rel.stream.pipe(
    distinct(),
    output((data) => {
      let total = 0
      for (const [, multiplicity] of data.getInner()) {
        total += multiplicity
      }
      console.log(`${prefix}: ${total}`)
    }),
  )
}

/** Attach a printer that emits each row of `rel` (with its diff). */
export function inspectContents<T extends Row>(rel: Rel<T>, name: string): void {
  rel.stream.pipe(
    distinct(),
    output((data) => {
      for (const [row, multiplicity] of data.getInner()) {
        console.log(`${name}: (${rowToString(row)}, ${multiplicity})`)
      }
    }),
  )
}

/** Attach a printer that emits rows of a DoubleRel (keyed view). */
export function inspectContentsKeyed<K extends Row, V extends Row>(
  rel: DoubleRel<K, V>,
  name: string,
): void {
  rel.stream.pipe(
    map(([k, v]) => [rowToString(k), rowToString(v)] as [string, string]),
    output((data) => {
      for (const [[k, v], multiplicity] of data.getInner()) {
        console.log(`${name}: ((${k}: ${v}), ${multiplicity})`)
      }
    }),
  )
}

/** Streaming inspect: invoke `callback(rowValues, diff)` for each row. */
export function inspectStreamingGeneric<T extends Row>(
  rel: Rel<T>,
  callback: (rowValues: string[], diff: number) => void,
): void {
  rel.stream.pipe(
    output((data) => {
      for (const [row, multiplicity] of data.getInner()) {
        callback(
          row.map((v) => v.toString()),
          multiplicity,
        )
      }
    }),
  )
}
