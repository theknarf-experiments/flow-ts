// Port of flowlog/src/planning/src/arithmetic.rs

import {
  type ArithmeticPos,
  type FactorPos,
  factorPosSignatures as _unused1,
} from '../catalog/index.js'
import type { ArithmeticOperator, Const, DataType } from '@flow-ts/parsing'
import { arithmeticOperatorToString, constToString } from '@flow-ts/parsing'
import {
  type TransformationArgument,
  jnFlip,
  transformationArgumentToString,
} from './arguments.js'

void _unused1

export type FactorArgument =
  | { kind: 'Var'; argument: TransformationArgument }
  | { kind: 'Const'; value: Const }

export function factorArgumentTransformationArguments(
  f: FactorArgument,
): TransformationArgument[] {
  return f.kind === 'Var' ? [f.argument] : []
}

export function factorArgumentToString(f: FactorArgument): string {
  return f.kind === 'Var'
    ? transformationArgumentToString(f.argument)
    : constToString(f.value)
}

export class ArithmeticArgument {
  constructor(
    public readonly init: FactorArgument,
    public readonly rest: ReadonlyArray<readonly [ArithmeticOperator, FactorArgument]>,
    public readonly dataType: DataType = 'Integer',
  ) {}

  /**
   * Replace each Var position in `arithmetic` (left-to-right) with the
   * corresponding TransformationArgument.
   */
  static fromArithmetic(
    arithmetic: ArithmeticPos,
    varArguments: readonly TransformationArgument[],
  ): ArithmeticArgument {
    let varId = 0
    const liftFactor = (f: FactorPos): FactorArgument => {
      if (f.kind === 'Var') {
        const arg = varArguments[varId++]
        if (!arg) {
          throw new Error(
            `ArithmeticArgument.fromArithmetic: not enough varArguments (${varArguments.length})`,
          )
        }
        return { kind: 'Var', argument: arg }
      }
      return { kind: 'Const', value: f.value }
    }
    const init = liftFactor(arithmetic.init)
    const rest: Array<readonly [ArithmeticOperator, FactorArgument]> = []
    for (const [op, factor] of arithmetic.rest) {
      rest.push([op, liftFactor(factor)] as const)
    }
    return new ArithmeticArgument(init, rest, arithmetic.dataType)
  }

  isLiteral(): boolean {
    return this.rest.length === 0
  }

  transformationArguments(): TransformationArgument[] {
    const out = factorArgumentTransformationArguments(this.init)
    for (const [, factor] of this.rest) {
      out.push(...factorArgumentTransformationArguments(factor))
    }
    return out
  }

  /** Construct a join-flipped twin (each underlying TransformationArgument is flipped). */
  jnFlip(): ArithmeticArgument {
    const flip = (f: FactorArgument): FactorArgument =>
      f.kind === 'Var' ? { kind: 'Var', argument: jnFlip(f.argument) } : f
    const init = flip(this.init)
    const rest: Array<readonly [ArithmeticOperator, FactorArgument]> = this.rest.map(
      ([op, factor]) => [op, flip(factor)] as const,
    )
    return new ArithmeticArgument(init, rest, this.dataType)
  }

  toString(): string {
    let s = factorArgumentToString(this.init)
    for (const [op, factor] of this.rest) {
      s += ` ${arithmeticOperatorToString(op)} ${factorArgumentToString(factor)}`
    }
    return s
  }
}
