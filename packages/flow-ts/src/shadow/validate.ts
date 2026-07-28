// Checking a request before it reaches the graph.
//
// A seed row is fed in as a fact, so its columns have to match the relation's
// types. When they didn't, nothing errored — the row simply failed to join, and
// the caller was told the row was "not derived from the current facts (stale?)".
// That sends you to look at your data when the problem is your request, which is
// the worst kind of error message: confidently pointing the wrong way.
//
// The distinction worth keeping is between a request that is *wrong* and one
// that is merely *unsatisfiable*. Wrong arity, wrong types, a relation that
// isn't there: mistakes, and they should say so precisely. Not-currently-derived
// is a legitimate answer about the data, and keeps its own wording.

import type { DataType, Program } from '../ast/index.js'
import type { Row } from '../reading/row.js'
import type { InferredTypes } from '../typing/index.js'
import type { BackwardRequest } from './resolve.js'

/** Human-readable reason the request is malformed, or null if it's well-formed. */
export function validateRequest(
  program: Program,
  inferred: InferredTypes,
  seeds: readonly string[],
  request: BackwardRequest,
): string | null {
  const { rel, row, newRow } = request

  if (!program.idbs.some((d) => d.name === rel)) {
    return `"${rel}" is not a derived relation of this program`
  }
  if (!seeds.includes(rel)) {
    const why = inferred.unresolved.find((u) => u.rel === rel)?.reason
    return (
      `"${rel}" has no seed channel, so it cannot be requested` + (why ? ` — ${why}` : '')
    )
  }

  const cols = inferred.types.get(rel)
  if (!cols) {
    /* c8 ignore next */
    return `column types for "${rel}" are unknown`
  }

  const shape = checkRow(rel, cols, row, 'row')
  if (shape) return shape
  if (newRow) {
    const replacement = checkRow(rel, cols, newRow, 'replacement row')
    if (replacement) return replacement
  }
  return null
}

function checkRow(
  rel: string,
  cols: readonly DataType[],
  row: Row,
  what: string,
): string | null {
  if (row.length !== cols.length) {
    return `${rel} has ${cols.length} ${cols.length === 1 ? 'column' : 'columns'}, but the ${what} has ${row.length}`
  }
  for (let i = 0; i < cols.length; i++) {
    const want = cols[i]!
    const got = row[i]
    // Integer and Float are the same JS number at runtime, so they are
    // interchangeable here; only the number/string split is real.
    const ok = want === 'String' ? typeof got === 'string' : typeof got === 'number'
    if (!ok) {
      return (
        `${rel} column ${i} expects ${want === 'String' ? 'string' : 'number'}, ` +
        `but the ${what} has ${typeof got} (${JSON.stringify(got)})`
      )
    }
  }
  return null
}
