// Node-only filesystem helpers used by the CLI binary. Mirrors the Rust
// `reading::reader` (CSV-into-rows) and the fs portion of `reading::inspect`
// (CSV-output for IDB heads + partition merging).
//
// Keeping these here, rather than in `@flow-ts/reading`, lets the executor
// and reading packages stay browser-compatible.

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Attribute, RelDecl } from '@flow-ts/parsing'
import { codecFor, type Row, type Value } from '@flow-ts/reading'

/** Yield all non-empty lines of a file as strings. Tolerates `\r\n`
 *  line endings — trailing `\r` is stripped so downstream parsers see
 *  a clean payload. Multi-line quoted CSV fields aren't supported. */
export function readerLines(filePath: string): string[] {
  const content = fs.readFileSync(filePath, 'utf8')
  return content
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
}

/** Format a single value as one CSV field, applying RFC-4180-style
 *  quoting only when the field would otherwise be ambiguous (contains
 *  the delimiter, a `"`, or a newline). Numbers never need quoting. */
function csvFormatField(v: Value, delimiter: string): string {
  if (typeof v !== 'string') return String(v)
  if (v === '') return '""'
  if (
    v.indexOf(delimiter) === -1 &&
    v.indexOf('"') === -1 &&
    v.indexOf('\n') === -1 &&
    v.indexOf('\r') === -1
  ) {
    return v
  }
  return `"${v.replace(/"/g, '""')}"`
}

/** Parse one CSV line into raw field strings, honouring RFC-4180-style
 *  quoting. Inputs MUST be single-line — a `\n` inside a quoted string
 *  would split the row at file-read time before we get here. */
function parseCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = []
  let i = 0
  while (i <= line.length) {
    // Lenient leading whitespace (handles `, value` style).
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++

    if (i < line.length && line[i] === '"') {
      // Quoted field. `""` inside collapses to a literal `"`.
      let buf = ''
      let p = i + 1
      let closed = false
      while (p < line.length) {
        if (line[p] === '"') {
          if (line[p + 1] === '"') {
            buf += '"'
            p += 2
            continue
          }
          closed = true
          p++
          break
        }
        buf += line[p]
        p++
      }
      if (!closed) {
        throw new Error(`csv: unterminated quoted field (line: ${line})`)
      }
      // Trailing whitespace, then delimiter or EOL.
      while (p < line.length && (line[p] === ' ' || line[p] === '\t')) p++
      out.push(buf)
      if (p >= line.length) return out
      if (line[p] !== delimiter) {
        throw new Error(
          `csv: junk after quoted field at position ${p} (line: ${line})`,
        )
      }
      i = p + 1
    } else {
      // Unquoted field: read until the next delimiter (or EOL). Trim so
      // `1, 2` reads the same as `1,2`.
      const next = line.indexOf(delimiter, i)
      if (next === -1) {
        out.push(line.slice(i).trim())
        return out
      }
      out.push(line.slice(i, next).trim())
      i = next + 1
    }
  }
  return out
}

/**
 * Read a CSV/facts file into rows. The legacy integer-only entry point:
 * every column is parsed as a JS `number`. Use `readRowsForRelDecl` to
 * dispatch through the per-column value codecs (string / float / etc).
 *
 * `id` / `peers` implement the FlowLog worker-sharding rule: the first
 * column mod `peers` selects which worker owns the row. With `peers = 1`,
 * every row is accepted (single-worker mode, which is the db-ivm default).
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
    const first = Number(firstRaw)
    if (first % peers !== id) continue

    const row: number[] = [first]
    for (let i = 1; i < fields.length; i++) {
      const raw = fields[i]!.trim()
      if (raw.length === 0) continue
      row.push(Number(raw))
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
 * Codec-aware variant of `readRows`. Each column is parsed via the
 * `ValueCodec` registered for its declared `DataType` — strings stay as
 * strings, floats stay as floats, ints stay as ints. Lines are parsed
 * with RFC-4180-style quoting, so a `"a,b"` field can contain the
 * delimiter without splitting the row. Multi-line strings (a `\n`
 * inside a quoted field) aren't supported — the file reader splits on
 * raw newlines before we see the line here.
 */
function readRowsTyped(
  relPath: string,
  delimiter: string,
  attributes: readonly Attribute[],
  id = 0,
  peers = 1,
): Row[] {
  const codecs = attributes.map((a) => codecFor(a.dataType))
  const out: Row[] = []
  for (const line of readerLines(relPath)) {
    const fields = parseCsvLine(line, delimiter)
    if (fields.length !== attributes.length) {
      throw new Error(
        `expected ${attributes.length} values, got ${fields.length} (line: ${line})`,
      )
    }
    // Worker sharding still keys off the first column. For non-numeric
    // first columns the modulus is taken on a string hash — but since
    // peers defaults to 1, the practical effect for typical single-worker
    // runs is that every row is accepted.
    const firstShard = shardKey(
      fields[0]!,
      codecs[0]!.matches(fields[0]![0] ?? '-') ? 'numeric' : 'string',
    )
    if (firstShard % peers !== id) continue

    const row: Value[] = fields.map((raw, i) => codecs[i]!.fromText(raw))
    out.push(row)
  }
  return out
}

function shardKey(raw: string, kind: 'numeric' | 'string'): number {
  if (kind === 'numeric') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : 0
  }
  // Simple FNV-1a-like fold so string-keyed sharding is at least
  // deterministic. Not cryptographic; not load-balanced; just stable.
  let h = 2166136261
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i)
    h = (h * 16777619) >>> 0
  }
  return h
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
 * Convenience: resolve a RelDecl into a path under `factsDir` and read it,
 * dispatching through the per-column value codecs. Mirrors the upstream
 * `read_row_generic` entry point. All-numeric programs run via the codec
 * path too — the integer codec's `fromText` matches the old `Number(...)`
 * behaviour.
 */
export function readRowsForRelDecl(
  relDecl: RelDecl,
  factsDir: string,
  delimiter: string,
  id = 0,
  peers = 1,
): Row[] {
  const fullPath = `${factsDir.replace(/\/$/, '')}/${relDeclInputPath(relDecl)}`
  return readRowsTyped(fullPath, delimiter, relDecl.attributes, id, peers)
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

/** Append one CSV row to `filePath`, reusing a cached file descriptor.
 *  Each field is formatted with RFC-4180-style quoting only when the
 *  raw value would otherwise collide with the delimiter, a `"`, or a
 *  newline — numeric columns and "boring" string columns stay unquoted
 *  so the output diffs cleanly against pre-quoting baselines. */
export function appendCsvRow(filePath: string, row: Row): void {
  const formatted = row.map((v) => csvFormatField(v, ',')).join(',')
  fs.writeSync(fdFor(filePath), `${formatted}\n`)
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
