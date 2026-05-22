// Port of flowlog/src/parsing/src/head.rs

import type { Aggregation } from './aggregation.js'
import type { Arithmetic } from './arithmetic.js'

export type HeadArg =
  | { kind: 'Var'; name: string }
  | { kind: 'Arith'; arithmetic: Arithmetic }
  | { kind: 'Aggregation'; aggregation: Aggregation }

export function headArgVars(arg: HeadArg): string[] {
  switch (arg.kind) {
    case 'Var':
      return [arg.name]
    case 'Arith':
      return arg.arithmetic.vars()
    case 'Aggregation':
      return arg.aggregation.vars()
  }
}

export function headArgToString(arg: HeadArg): string {
  switch (arg.kind) {
    case 'Var':
      return arg.name
    case 'Arith':
      return arg.arithmetic.toString()
    case 'Aggregation':
      return arg.aggregation.toString()
  }
}

export class Head {
  constructor(
    public readonly name: string,
    public readonly headArguments: HeadArg[],
  ) {}

  arity(): number {
    return this.headArguments.length
  }

  toString(): string {
    return `${this.name}(${this.headArguments.map(headArgToString).join(', ')})`
  }
}
