// Value typing for relation cells.
//
// flow-ts originally collapsed every row cell into a JS `number` for perf
// (see `row.ts`). To support `.decl Foo(name: string)` without re-litigating
// the row representation, this module introduces a tagged-union `Value`
// type plus a `ValueCodec` registry keyed by the parser-level `DataType`.
//
// Codec responsibilities:
//   • fromConst   — lower a parser `Const` into a runtime `Value`
//   • fromText    — parse a CSV cell (or similar) into a `Value`
//   • toText      — render a `Value` for display / CSV output
//   • encodeField — wire-safe field representation used by `encodeRow`
//   • decodeField — inverse of encodeField (called with the bare field)
//   • matches     — quick "does this field belong to me?" check on its
//                   first character; the decoder uses this to dispatch
//                   without consulting the schema
//
// Wire format: each field is followed by `,` (the encoder appends it).
// Inside the field:
//   • Numbers / floats: bare textual representation. First char is a
//     digit or `-`, so they can't collide with the string tag.
//   • Strings: a leading `'` tag, then content with `\` → `\\` and
//     `,` → `\,` escapes. The leading `'` makes the field self-describing
//     so `decodeRow` doesn't need the relation schema to pick a parser.
//
// Adding a new value type (Date, UUID, bigint) means registering one more
// codec — no changes to the planner, the operator runtime, or the wire
// format of other types.

import type { Const, DataType } from '../ast/index.js'

/** Union of all in-memory row cell types. Widen as new codecs land. */
export type Value = number | string

export interface ValueCodec<T extends Value> {
  /** Lower a parser-level `Const` literal into a runtime Value. */
  fromConst(c: Const): T
  /** Parse a textual representation (e.g. a CSV cell). */
  fromText(s: string): T
  /** Render a Value as text for display / CSV output. */
  toText(v: T): string
  /** Encode a Value into a wire-safe field (no terminator). */
  encodeField(v: T): string
  /** Decode a wire-safe field back to a Value. */
  decodeField(field: string): T
  /** True iff the field belongs to this codec, based on its first char.
   *  Used by `decodeRow` to pick a parser without the schema. */
  matches(firstChar: string): boolean
}

const INTEGER_CODEC: ValueCodec<number> = {
  fromConst(c) {
    if (c.kind === 'Integer') return c.value
    if (c.kind === 'Float') return c.value
    throw new Error(`integer codec: cannot lower ${c.kind} constant`)
  },
  fromText(s) {
    const n = Number(s)
    if (!Number.isFinite(n)) throw new Error(`integer codec: not a number: ${s}`)
    return n
  },
  toText(v) {
    return String(v)
  },
  encodeField(v) {
    return String(v)
  },
  decodeField(field) {
    return Number(field)
  },
  matches(firstChar) {
    // JS number formatting starts with a digit or `-`. `Infinity` / `NaN`
    // would collide here but we don't produce them for ordinary integer
    // values — and a string starting with `I` or `N` would also hit the
    // string codec's `'` tag check first.
    return firstChar === '-' || (firstChar >= '0' && firstChar <= '9')
  },
}

const STRING_CODEC: ValueCodec<string> = {
  fromConst(c) {
    if (c.kind === 'Text') return c.value
    throw new Error(`string codec: cannot lower ${c.kind} constant`)
  },
  fromText(s) {
    return s
  },
  toText(v) {
    return v
  },
  encodeField(v) {
    // Order matters: escape `\` first so we don't double-escape the
    // backslashes we'd introduce escaping `,`.
    return "'" + v.replace(/\\/g, '\\\\').replace(/,/g, '\\,')
  },
  decodeField(field) {
    // Strip leading `'` tag, then collapse `\<x>` → `<x>` in one pass.
    return field.slice(1).replace(/\\(.)/g, '$1')
  },
  matches(firstChar) {
    return firstChar === "'"
  },
}

// Floats and integers share the same JS representation (float64), the
// same wire format (`String(v)` — JS prints `42` for `42`, `3.14` for
// `3.14`), and the same arithmetic. The codec slot still exists per
// `DataType` so a future change that needs to distinguish them — e.g.
// stricter parsing or a different render — has a place to live.
const FLOAT_CODEC: ValueCodec<number> = INTEGER_CODEC

const CODECS_BY_DATATYPE: Record<DataType, ValueCodec<Value>> = {
  Integer: INTEGER_CODEC,
  String: STRING_CODEC,
  Float: FLOAT_CODEC,
}

/** Codec for the cells of a given attribute. Throws on unknown types so
 *  unregistered `DataType` cases fail loudly instead of silently dropping
 *  to a numeric fallback. */
export function codecFor(dataType: DataType): ValueCodec<Value> {
  const c = CODECS_BY_DATATYPE[dataType]
  if (!c) throw new Error(`no value codec registered for ${dataType}`)
  return c
}

/** Codec lookup by a field's first wire character. Used inside
 *  `decodeRow` / `decodeField` to recover the JS type without the schema. */
export function codecForFieldChar(firstChar: string): ValueCodec<Value> {
  if (STRING_CODEC.matches(firstChar)) return STRING_CODEC
  if (INTEGER_CODEC.matches(firstChar)) return INTEGER_CODEC
  throw new Error(`no value codec matches field tag '${firstChar}'`)
}

/** Lower any `Const` literal into the runtime Value it represents.
 *  Text → string, Integer/Float → number. */
export function constToValue(c: Const): Value {
  switch (c.kind) {
    case 'Integer':
      return INTEGER_CODEC.fromConst(c)
    case 'Float':
      return FLOAT_CODEC.fromConst(c)
    case 'Text':
      return STRING_CODEC.fromConst(c)
  }
}
