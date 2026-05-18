// Node-only filesystem helpers used by the CLI binary. Mirrors the Rust
// `reading::reader` (CSV-into-rows) and the fs portion of `reading::inspect`
// (CSV-output for IDB heads + partition merging).
//
// Keeping these here, rather than in `@flow-ts/reading`, lets the executor
// and reading packages stay browser-compatible.

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { RelDecl } from '@flow-ts/parsing'
import type { Row } from '@flow-ts/reading'

/** Yield all non-empty lines of a file as strings. */
export function readerLines(filePath: string): string[] {
  const content = fs.readFileSync(filePath, 'utf8')
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
 * Resolve a RelDecl's effective input filename. When `.input <path>` is
 * declared, that path is used; otherwise the upstream convention is
 * `<rel_name>.facts` (see `flowlog/src/executing/src/dataflow.rs`).
 */
export function relDeclInputPath(relDecl: RelDecl): string {
  return relDecl.path ?? `${relDecl.name}.facts`
}

/**
 * Convenience: resolve a RelDecl into a path under `factsDir` and read it.
 * Mirrors the upstream `read_row_generic` entry point.
 */
export function readRowsForRelDecl(
  relDecl: RelDecl,
  factsDir: string,
  delimiter: string,
  id = 0,
  peers = 1,
): Row[] {
  const fullPath = `${factsDir.replace(/\/$/, '')}/${relDeclInputPath(relDecl)}`
  return readRows(fullPath, delimiter, relDecl.arity(), id, peers)
}

// ---------------------------------------------------------------------
// IDB CSV output
// ---------------------------------------------------------------------

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

/** Append one CSV row to `filePath`, reusing a cached file descriptor. */
export function appendCsvRow(filePath: string, row: readonly bigint[]): void {
  fs.writeSync(fdFor(filePath), `${row.map((v) => v.toString()).join(',')}\n`)
}

/** Append one `name: size` line to `filePath`. */
export function appendSizeLine(filePath: string, name: string, size: number): void {
  fs.writeSync(fdFor(filePath), `${name}: ${size}\n`)
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
