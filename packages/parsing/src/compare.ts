// Port of flowlog/src/parsing/src/compare.rs

import type { Arithmetic } from './arithmetic.js'

export type ComparisonOperator =
  | 'Equals'
  | 'NotEquals'
  | 'GreaterThan'
  | 'GreaterEqualThan'
  | 'LessThan'
  | 'LessEqualThan'

export function comparisonOperatorIsEquals(op: ComparisonOperator): boolean {
  return op === 'Equals'
}

export function comparisonOperatorToString(op: ComparisonOperator): string {
  // ASCII forms that round-trip through the parser. The upstream Rust uses
  // unicode (≠/≥/≤) for its Display impl; we use the parser-compatible
  // spellings so `programToDl` output is round-trippable.
  switch (op) {
    case 'Equals':
      return '=='
    case 'NotEquals':
      return '!='
    case 'GreaterThan':
      return '>'
    case 'GreaterEqualThan':
      return '>='
    case 'LessThan':
      return '<'
    case 'LessEqualThan':
      return '<='
  }
}

export class ComparisonExpr {
  constructor(
    public readonly left: Arithmetic,
    public readonly operator: ComparisonOperator,
    public readonly right: Arithmetic,
  ) {}

  leftVars(): string[] {
    return this.left.vars()
  }

  rightVars(): string[] {
    return this.right.vars()
  }

  varsSet(): Set<string> {
    const s = this.left.varsSet()
    for (const v of this.right.varsSet()) s.add(v)
    return s
  }

  toString(): string {
    return `${this.left.toString()} ${comparisonOperatorToString(this.operator)} ${this.right.toString()}`
  }
}
