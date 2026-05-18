// Port of flowlog/src/catalog/src/arithmetic.rs

import type { Arithmetic, ArithmeticOperator, Const, DataType } from '@flow-ts/parsing'
import { arithmeticOperatorToString, constToString } from '@flow-ts/parsing'
import type { AtomArgumentSignature } from './atoms.js'

/** Positional analog of `parsing::Factor`: variables are resolved to argument signatures. */
export type FactorPos =
  | { kind: 'Var'; signature: AtomArgumentSignature }
  | { kind: 'Const'; value: Const }

export function factorPosSignatures(f: FactorPos): AtomArgumentSignature[] {
  return f.kind === 'Var' ? [f.signature] : []
}

export function factorPosToString(f: FactorPos): string {
  return f.kind === 'Var' ? f.signature.toString() : constToString(f.value)
}

/** Positional analog of `parsing::Arithmetic`. */
export class ArithmeticPos {
  constructor(
    public readonly init: FactorPos,
    public readonly rest: ReadonlyArray<readonly [ArithmeticOperator, FactorPos]>,
    public readonly dataType: DataType = 'Integer',
  ) {}

  /**
   * Replace each variable Factor in `arithmetic` with the corresponding entry
   * from `varSignatures` (in left-to-right order).
   */
  static fromArithmetic(
    arithmetic: Arithmetic,
    varSignatures: readonly AtomArgumentSignature[],
  ): ArithmeticPos {
    let varId = 0
    const liftFactor = (
      f: import('@flow-ts/parsing').Factor,
    ): FactorPos => {
      if (f.kind === 'Var') {
        const sig = varSignatures[varId++]
        if (!sig) {
          throw new Error(
            `ArithmeticPos.fromArithmetic: not enough varSignatures (${varSignatures.length})`,
          )
        }
        return { kind: 'Var', signature: sig }
      }
      return { kind: 'Const', value: f.value }
    }
    const init = liftFactor(arithmetic.init)
    const rest: Array<readonly [ArithmeticOperator, FactorPos]> = []
    for (const [op, factor] of arithmetic.rest) {
      rest.push([op, liftFactor(factor)] as const)
    }
    return new ArithmeticPos(init, rest, arithmetic.dataType)
  }

  isLiteral(): boolean {
    return this.rest.length === 0
  }

  isVar(): boolean {
    return this.isLiteral() && this.init.kind === 'Var'
  }

  signatures(): AtomArgumentSignature[] {
    const out = factorPosSignatures(this.init)
    for (const [, f] of this.rest) out.push(...factorPosSignatures(f))
    return out
  }

  toString(): string {
    let s = factorPosToString(this.init)
    for (const [op, f] of this.rest) {
      s += ` ${arithmeticOperatorToString(op)} ${factorPosToString(f)}`
    }
    return s
  }
}
