// Port of `Const` in flowlog/src/parsing/src/rule.rs.
//
// JS numbers are already IEEE-754 float64, so `Float` cells store the
// value directly — no bit-reinterpretation needed. (The Rust port carries
// the bit pattern around because its row storage is i64-only.)

export type Const =
  | { kind: 'Integer'; value: number }
  | { kind: 'Text'; value: string }
  | { kind: 'Float'; value: number }

export function constToString(c: Const): string {
  switch (c.kind) {
    case 'Integer':
      return c.value.toString()
    case 'Text':
      // Quote so the output round-trips through the parser. Upstream Rust
      // emits the raw text; we wrap it.
      return `"${c.value}"`
    case 'Float':
      return c.value.toString()
  }
}

export function constInteger(c: Const): number {
  if (c.kind !== 'Integer') {
    throw new Error(`expects ints: ${JSON.stringify(c)}`)
  }
  return c.value
}
