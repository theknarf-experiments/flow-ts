// Port of flowlog/src/catalog/src/compare.rs

import type { ComparisonExpr, ComparisonOperator } from '@flow-ts/parsing'
import { comparisonOperatorToString } from '@flow-ts/parsing'
import { ArithmeticPos } from './arithmetic.js'
import type { AtomArgumentSignature } from './atoms.js'

export class ComparisonExprPos {
  constructor(
    public readonly left: ArithmeticPos,
    public readonly operator: ComparisonOperator,
    public readonly right: ArithmeticPos,
  ) {}

  static fromComparisonExpr(
    expr: ComparisonExpr,
    leftVarSignatures: readonly AtomArgumentSignature[],
    rightVarSignatures: readonly AtomArgumentSignature[],
  ): ComparisonExprPos {
    return new ComparisonExprPos(
      ArithmeticPos.fromArithmetic(expr.left, leftVarSignatures),
      expr.operator,
      ArithmeticPos.fromArithmetic(expr.right, rightVarSignatures),
    )
  }

  signatures(): AtomArgumentSignature[] {
    return [...this.left.signatures(), ...this.right.signatures()]
  }

  toString(): string {
    return `[${this.left.toString()} ${comparisonOperatorToString(this.operator)} ${this.right.toString()}]`
  }
}
