// Port of flowlog/src/reading/src/reader.rs
//
// The Rust crate generates per-arity reader functions via a macro (read_row_1
// through read_row_8 plus a fat fallback). In TS that's unnecessary — a
// single reader returns `Row` values of whatever arity is needed.

import * as fs from 'node:fs'
import type { RelDecl } from '@flow-ts/parsing'
import type { Row } from './row.js'

/** Yield all non-empty lines of a file as strings. */
export function readerLines(path: string): string[] {
  const content = fs.readFileSync(path, 'utf8')
  return content.split('\n').filter((line) => line.length > 0)
}

/**
 * Read a CSV/facts file into rows. Each value is parsed as a bigint integer.
 *
 * `id` / `peers` implement the FlowLog worker-sharding rule: the first column
 * mod `peers` selects which worker owns the row. With `peers = 1`, every row
 * is accepted (single-worker mode, which is the d2ts default).
 */
export function readRows(
  relPath: string,
  delimiter: string,
  expectedArity: number,
  id = 0,
  peers = 1,
): Row[] {
  const out: Row[] = []
  for (const line of readerLines(relPath)) {
    const fields = line.split(delimiter)
    if (fields.length === 0) continue
    const firstRaw = fields[0]!.trim()
    const first = BigInt(firstRaw)
    if (Number(first) % peers !== id) continue

    const row: bigint[] = [first]
    for (let i = 1; i < fields.length; i++) {
      const raw = fields[i]!.trim()
      if (raw.length === 0) continue
      row.push(BigInt(raw))
    }
    if (row.length !== expectedArity) {
      throw new Error(
        `expected ${expectedArity} values, got ${row.length} (line: ${line})`,
      )
    }
    out.push(row)
  }
  return out
}

/**
 * Convenience: resolve a RelDecl into a path under `factsDir` (using its
 * declared input path) and read it. Mirrors the upstream `read_row_generic`
 * entry point.
 */
export function readRowsForRelDecl(
  relDecl: RelDecl,
  factsDir: string,
  delimiter: string,
  id = 0,
  peers = 1,
): Row[] {
  if (!relDecl.path) {
    throw new Error(`relation ${relDecl.name} has no input path`)
  }
  const fullPath = `${factsDir.replace(/\/$/, '')}/${relDecl.path}`
  return readRows(fullPath, delimiter, relDecl.arity(), id, peers)
}
