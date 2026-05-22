// Port of flowlog/src/planning/src/compare.rs

import type { ComparisonExprPos } from '../catalog/index.js'
import type { ComparisonOperator } from '@flow-ts/parsing'
import { comparisonOperatorToString } from '@flow-ts/parsing'
import type { TransformationArgument } from './arguments.js'
import { ArithmeticArgument } from './arithmetic.js'

export class ComparisonExprArgument {
  constructor(
    public readonly left: ArithmeticArgument,
    public readonly operator: ComparisonOperator,
    public readonly right: ArithmeticArgument,
  ) {}

  static fromComparisonExpr(
    expr: ComparisonExprPos,
    leftArguments: readonly TransformationArgument[],
    rightArguments: readonly TransformationArgument[],
  ): ComparisonExprArgument {
    return new ComparisonExprArgument(
      ArithmeticArgument.fromArithmetic(expr.left, leftArguments),
      expr.operator,
      ArithmeticArgument.fromArithmetic(expr.right, rightArguments),
    )
  }

  transformationArguments(): TransformationArgument[] {
    return [...this.left.transformationArguments(), ...this.right.transformationArguments()]
  }

  jnFlip(): ComparisonExprArgument {
    return new ComparisonExprArgument(this.left.jnFlip(), this.operator, this.right.jnFlip())
  }

  toString(): string {
    return `${this.left.toString()} ${comparisonOperatorToString(this.operator)} ${this.right.toString()}`
  }
}
