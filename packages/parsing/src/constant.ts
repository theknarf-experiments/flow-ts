// Port of `Const` in flowlog/src/parsing/src/rule.rs

export type Const =
  | { kind: 'Integer'; value: bigint }
  | { kind: 'Text'; value: string }
  /** Float stored as IEEE-754 bit pattern in an i64 (bigint). */
  | { kind: 'Float'; bits: bigint }

export function constToString(c: Const): string {
  switch (c.kind) {
    case 'Integer':
      return c.value.toString()
    case 'Text':
      // Quote so the output round-trips through the parser. Upstream Rust
      // emits the raw text; we wrap it.
      return `"${c.value}"`
    case 'Float': {
      const buf = new ArrayBuffer(8)
      new BigInt64Array(buf)[0] = c.bits
      return new Float64Array(buf)[0]!.toString()
    }
  }
}

export function constAsI64(c: Const): bigint {
  switch (c.kind) {
    case 'Integer':
      return c.value
    case 'Float':
      return c.bits
    case 'Text':
      throw new Error(`constAsI64 on Text constant: ${c.value}`)
  }
}

export function constInteger(c: Const): bigint {
  if (c.kind !== 'Integer') {
    throw new Error(`expects ints: ${JSON.stringify(c)}`)
  }
  return c.value
}
