// Port of `Const` in flowlog/src/parsing/src/rule.rs

export type Const =
  | { kind: 'Integer'; value: number }
  | { kind: 'Text'; value: string }
  /** Float stored as IEEE-754 bit pattern; kept as bigint so we don't lose
   *  the top 11 bits when round-tripping through a JS Number. */
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

/** Project Integer / Float constants to a single numeric channel. Used by
 *  evaluators that operate on the value as if it were an i64 or float64. */
export function constAsNumber(c: Const): number {
  switch (c.kind) {
    case 'Integer':
      return c.value
    case 'Float': {
      const buf = new ArrayBuffer(8)
      new BigInt64Array(buf)[0] = c.bits
      return new Float64Array(buf)[0]!
    }
    case 'Text':
      throw new Error(`constAsNumber on Text constant: ${c.value}`)
  }
}

export function constInteger(c: Const): number {
  if (c.kind !== 'Integer') {
    throw new Error(`expects ints: ${JSON.stringify(c)}`)
  }
  return c.value
}
