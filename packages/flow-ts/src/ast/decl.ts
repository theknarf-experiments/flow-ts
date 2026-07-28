// Port of flowlog/src/parsing/src/decl.rs

export type DataType = 'Integer' | 'String' | 'Float'

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
  /** Which rule an *insertion* satisfies, named by a relation its body
   *  mentions. Deletion through a multi-rule head is mechanical — killing a
   *  disjunction kills every disjunct — but satisfying one is a choice, and
   *  nothing in the program makes it. */
  | { kind: 'insertVia'; rel: string }

export function putPolicyToString(p: PutPolicy): string {
  switch (p.kind) {
    case 'none':
      return '.put none'
    case 'spread':
      return `.put spread(${p.residual})`
    case 'into':
      return `.put into ${p.rel}`
    case 'insertVia':
      return `.put insert via ${p.rel}`
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
