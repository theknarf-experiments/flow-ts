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

export class RelDecl {
  constructor(
    public readonly name: string,
    public readonly attributes: Attribute[],
    public readonly path: string | null,
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
