// Port of flowlog/src/parsing/src/arithmetic.rs

import type { Const } from './constant.js'
import { constToString } from './constant.js'
import type { DataType } from './decl.js'

export type ArithmeticOperator = 'Plus' | 'Minus' | 'Multiply' | 'Divide' | 'Modulo'

export function arithmeticOperatorToString(op: ArithmeticOperator): string {
  switch (op) {
    case 'Plus':
      return '+'
    case 'Minus':
      return '-'
    case 'Multiply':
      return '*'
    case 'Divide':
      return '/'
    case 'Modulo':
      return '%'
  }
}

export type Factor =
  | { kind: 'Var'; name: string }
  | { kind: 'Const'; value: Const }

export function factorIsVar(f: Factor): boolean {
  return f.kind === 'Var'
}

export function factorVars(f: Factor): string[] {
  return f.kind === 'Var' ? [f.name] : []
}

export function factorVarsSet(f: Factor): Set<string> {
  return new Set(factorVars(f))
}

export function factorToString(f: Factor): string {
  return f.kind === 'Var' ? f.name : constToString(f.value)
}

export class Arithmetic {
  constructor(
    public readonly init: Factor,
    public readonly rest: ReadonlyArray<readonly [ArithmeticOperator, Factor]>,
    public readonly dataType: DataType = 'Integer',
  ) {}

  isVar(): boolean {
    return factorIsVar(this.init) && this.rest.length === 0
  }

  vars(): string[] {
    const out = factorVars(this.init)
    for (const [, factor] of this.rest) {
      out.push(...factorVars(factor))
    }
    return out
  }

  varsSet(): Set<string> {
    return new Set(this.vars())
  }

  toString(): string {
    const initStr = factorToString(this.init)
    if (this.rest.length === 0) return initStr
    const restStr = this.rest
      .map(([op, f]) => `${arithmeticOperatorToString(op)} ${factorToString(f)}`)
      .join(' ')
    return `${initStr} ${restStr}`
  }
}
