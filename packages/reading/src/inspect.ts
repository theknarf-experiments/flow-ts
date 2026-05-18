// Port of flowlog/src/reading/src/inspect.rs
//
// Printing / file-output helpers, adapted to d2ts. The Rust version uses
// `inspect` and per-arity dispatch; we use `output()` from d2ts, which gives
// the full message envelope. Each helper attaches an output handler to a
// `Rel` and returns the same Rel for chaining.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { MessageType, distinct, map, output } from '@electric-sql/d2ts'
import { type Rel, type DoubleRel } from './rel.js'
import { type Row, rowToString } from './row.js'

/** Attach a printer that reports the per-version cardinality of `rel`. */
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
    output((msg) => {
      if (msg.type !== MessageType.DATA) return
      let total = 0
      for (const [, multiplicity] of msg.data.collection.getInner()) {
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
    output((msg) => {
      if (msg.type !== MessageType.DATA) return
      for (const [row, multiplicity] of msg.data.collection.getInner()) {
        console.log(`${name}: (${rowToString(row)}, ${msg.data.version}, ${multiplicity})`)
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
    output((msg) => {
      if (msg.type !== MessageType.DATA) return
      for (const [[k, v], multiplicity] of msg.data.collection.getInner()) {
        console.log(`${name}: ((${k}: ${v}), ${msg.data.version}, ${multiplicity})`)
      }
    }),
  )
}

// File-output helpers (sync; mirror the Rust implementations).

const fileHandles = new Map<string, number>()

function fdFor(filePath: string): number {
  let fd = fileHandles.get(filePath)
  if (fd === undefined) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fd = fs.openSync(filePath, 'w')
    fileHandles.set(filePath, fd)
  }
  return fd
}

/** Stream the size of `rel` (one number per version) into `filePath`. */
export function writeRelSize<T extends Row>(
  rel: Rel<T>,
  name: string,
  filePath: string,
): void {
  rel.stream.pipe(
    distinct(),
    output((msg) => {
      if (msg.type !== MessageType.DATA) return
      let total = 0
      for (const [, multiplicity] of msg.data.collection.getInner()) {
        total += multiplicity
      }
      fs.writeSync(fdFor(filePath), `${name}: ${total}\n`)
    }),
  )
}

/** Stream the contents of `rel` (one row per line) into `filePath{workerId}`. */
export function writeRel<T extends Row>(
  rel: Rel<T>,
  filePath: string,
  workerId: number,
): void {
  const path = `${filePath}${workerId}`
  rel.stream.pipe(
    distinct(),
    output((msg) => {
      if (msg.type !== MessageType.DATA) return
      for (const [row] of msg.data.collection.getInner()) {
        fs.writeSync(fdFor(path), `${rowToString(row)}\n`)
      }
    }),
  )
}

/**
 * Merge per-worker partition files into one. The Rust port writes worker
 * outputs to `{path}{id}` and then concatenates them; with d2ts being
 * single-threaded by default this is usually unnecessary but is kept for
 * API compatibility.
 */
export function mergeRelationPartitions(outputPath: string, workerCount: number): void {
  const out = fs.openSync(outputPath, 'w')
  try {
    for (let workerId = 0; workerId < workerCount; workerId++) {
      const partPath = `${outputPath}${workerId}`
      try {
        const content = fs.readFileSync(partPath, 'utf8')
        fs.writeSync(out, content)
      } catch {
        // Missing/unreadable partitions are silently skipped — matches Rust.
      }
    }
  } finally {
    fs.closeSync(out)
  }

  for (let workerId = 0; workerId < workerCount; workerId++) {
    const partPath = `${outputPath}${workerId}`
    try {
      fs.unlinkSync(partPath)
    } catch {
      // ignore
    }
  }
}

/** Streaming inspect: invoke `callback(rowValues, diff)` for each row. */
export function inspectStreamingGeneric<T extends Row>(
  rel: Rel<T>,
  callback: (rowValues: string[], diff: number) => void,
): void {
  rel.stream.pipe(
    output((msg) => {
      if (msg.type !== MessageType.DATA) return
      for (const [row, multiplicity] of msg.data.collection.getInner()) {
        callback(
          row.map((v) => v.toString()),
          multiplicity,
        )
      }
    }),
  )
}

/** Close all output files created by the helpers above. */
export function closeAllFiles(): void {
  for (const fd of fileHandles.values()) {
    try {
      fs.closeSync(fd)
    } catch {
      // ignore
    }
  }
  fileHandles.clear()
}
