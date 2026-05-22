// Port of flowlog/src/planning/src/constraints.rs

import type { Const } from '@flow-ts/parsing'
import { constToString } from '@flow-ts/parsing'
import {
  type TransformationArgument,
  transformationArgumentToString,
} from './arguments.js'

/**
 * Constraints baked into a TransformationFlow:
 *   - constant equalities  (x = 3)
 *   - variable equalities  (y = x)
 */
export class BaseConstraints {
  constructor(
    public readonly constantEqConstraints: ReadonlyArray<readonly [TransformationArgument, Const]>,
    public readonly variableEqConstraints: ReadonlyArray<
      readonly [TransformationArgument, TransformationArgument]
    >,
  ) {}

  isEmpty(): boolean {
    return (
      this.constantEqConstraints.length === 0 && this.variableEqConstraints.length === 0
    )
  }

  toString(): string {
    const parts: string[] = []
    for (const [arg, c] of this.constantEqConstraints) {
      parts.push(`${transformationArgumentToString(arg)} = ${constToString(c)}`)
    }
    for (const [a, b] of this.variableEqConstraints) {
      parts.push(
        `${transformationArgumentToString(a)} = ${transformationArgumentToString(b)}`,
      )
    }
    return parts.join(', ')
  }
}
