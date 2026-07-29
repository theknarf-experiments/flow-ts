// Port of flowlog/src/parsing/src/decl.rs

import type { Const } from './constant.js'
import { constToString } from './constant.js'

/** A column's declared type.
 *
 *  `Any` is the top of this lattice: a column that holds whichever of the
 *  others turns up. It is the honest declaration for data whose shape is the
 *  host's business rather than the program's — an id that is a number in one
 *  source and a slug in another, a property bag, a CSV column nobody has
 *  characterised yet — and it costs nothing at runtime, because the wire
 *  encoding tags every field with its own type already (see
 *  `reading/value.ts`). What it does not do is widen the *values*: `Any` still
 *  means number or string, the two things a row cell can be. */
export type DataType = 'Integer' | 'String' | 'Float' | 'Any'

export const NULL_SENTINEL = -9223372036854775808n // i64::MIN as bigint

export function isNull(v: bigint): boolean {
  return v === NULL_SENTINEL
}

export function parseDataType(s: string): DataType {
  switch (s) {
    case 'number':
      return 'Integer'
    case 'string':
      return 'String'
    case 'float':
      return 'Float'
    case 'any':
      return 'Any'
    default:
      throw new Error(`unknown data type: ${s}`)
  }
}

export function dataTypeToString(dt: DataType): string {
  switch (dt) {
    case 'Integer':
      return 'number'
    case 'String':
      return 'string'
    case 'Float':
      return 'float'
    case 'Any':
      return 'any'
  }
}

export class Attribute {
  constructor(
    public readonly name: string,
    public readonly dataType: DataType,
  ) {}

  toString(): string {
    return `${this.name}: ${dataTypeToString(this.dataType)}`
  }
}

/** How a derived relation is written back, when the rule that defines it
 *  doesn't determine that on its own.
 *
 *  Inverting a linear aggregate distributes the change by least change —
 *  forced over the reals, since minimising Σδᵢ² subject to Σδᵢ = Δ gives
 *  δᵢ = Δ/n. Over the integers it isn't: ⌊Δ/n⌋ each leaves a remainder, and
 *  which member absorbs it is a free choice. `spread` names that choice.
 *  `none` marks a relation read-only on purpose, so a refusal reads as a
 *  decision rather than an omission. */
export type PutPolicy =
  | { kind: 'none' }
  | { kind: 'spread'; residual: 'min' | 'max' }
  /** Land writes on this body relation, holding the rest of the body constant.
   *  Bancilhon & Spyratos' constant complement, named directly: the side you
   *  don't write is the invariant that makes the update well-defined. */
  | { kind: 'into'; rel: string }
  /** How an *insertion* is carried out.
   *
   *  `via` names which rule to satisfy, by a relation its body mentions:
   *  deleting through a multi-rule head is mechanical, since killing a
   *  disjunction kills every disjunct, but satisfying one is a choice nothing
   *  in the program makes.
   *
   *  `defaults` supplies values for body variables the head doesn't carry.
   *  Deleting and rewriting recover those by replaying the body against a row
   *  that already exists; inserting has no such row, so the value has to come
   *  from somewhere, and the schema is where that convention belongs. */
  | { kind: 'insert'; via: string | null; defaults: Array<[string, Const]> }

export function putPolicyToString(p: PutPolicy): string {
  switch (p.kind) {
    case 'none':
      return '.put none'
    case 'spread':
      return `.put spread(${p.residual})`
    case 'into':
      return `.put into ${p.rel}`
    case 'insert': {
      const via = p.via ? ` via ${p.via}` : ''
      const defs = p.defaults.length
        ? ` defaults(${p.defaults.map(([n, c]) => `${n} = ${constToString(c)}`).join(', ')})`
        : ''
      return `.put insert${via}${defs}`
    }
  }
}

export class RelDecl {
  constructor(
    public readonly name: string,
    public readonly attributes: Attribute[],
    public readonly path: string | null,
    /** Backward-direction policy, from a `.put` directive. IDBs only. */
    public readonly put: PutPolicy | null = null,
  ) {}

  arity(): number {
    return this.attributes.length
  }

  pushAttr(attr: Attribute): void {
    this.attributes.push(attr)
  }

  toString(): string {
    const attrs = this.attributes.map((a) => a.toString()).join(', ')
    const base = `${this.name}(${attrs})`
    return this.path ? `${base} read as ${this.path}` : base
  }
}
