// Canonical Row ↔ string encoding for use as Map keys in joins/reduces.
//
// db-ivm's `Index` uses raw JS Map equality for the top-level join key, so
// content-distinct rows used as keys must collapse to a primitive. We
// encode rows as `,`-terminated concatenations of self-describing fields:
//
//   • Numbers (Integer / Float) write `String(v)` verbatim — the first
//     character is always a digit or `-`.
//   • Strings write a leading `'` tag, then content with `\` → `\\` and
//     `,` → `\,` escapes — so a string containing `,` is unambiguous and
//     two distinct rows never collide.
//
// Each field's first character identifies its codec (see `value.ts`),
// which means `decodeRow` recovers the JS type without consulting the
// relation schema. The field-boundary scan only cares about escape: a
// `\` always swallows the next character, so an escaped `\,` does not
// terminate a field. Codecs do their own unescape on the raw on-wire
// bytes — keeping the responsibility in one place per type.

import type { Row } from './row.js'
import { codecForFieldChar, type Value } from './value.js'

/** Encode a Row to a canonical comma-delimited string. */
export function encodeRow(row: Row): string {
  let s = ''
  for (let i = 0; i < row.length; i++) {
    const v = row[i]!
    if (typeof v === 'string') {
      // Inline the string codec's encode rule on the hot path. Escape
      // `\` first so we don't double-process the backslashes we'd
      // introduce escaping `,`.
      s += "'" + v.replace(/\\/g, '\\\\').replace(/,/g, '\\,')
    } else {
      s += v
    }
    s += ','
  }
  return s
}

/** Inverse of `encodeRow`. Empty string → empty row. */
export function decodeRow(k: string): Value[] {
  if (k === '') return []
  const out: Value[] = []
  let start = 0
  let i = 0
  while (i < k.length) {
    const ch = k[i]!
    if (ch === '\\') {
      // Backslash always swallows the next character — `\,` is a
      // literal comma inside a string field, not a terminator.
      i += 2
      continue
    }
    if (ch === ',') {
      out.push(decodeField(k.substring(start, i)))
      start = i + 1
    }
    i++
  }
  // A well-formed encoded row always ends in `,`, so `start === k.length`
  // here. Tolerate a trailing field for callers that hand us bare data.
  if (start < k.length) out.push(decodeField(k.substring(start)))
  return out
}

/** Decode a single on-wire field (no terminator) to a Value. Dispatches
 *  through the codec registry by inspecting the field's first character. */
function decodeField(field: string): Value {
  if (field === '') {
    // Unreachable from `encodeRow` — every encoded field has at least one
    // character (the leading `'` tag for strings, or one digit/`-` for
    // numbers). Match the legacy behaviour and treat empty as `0`.
    return 0
  }
  return codecForFieldChar(field[0]!).decodeField(field)
}
