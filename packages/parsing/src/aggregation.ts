// Port of flowlog/src/parsing/src/aggregation.rs

import type { Arithmetic } from './arithmetic.js'
import type { DataType } from './decl.js'

export type AggregationOperator = 'Min' | 'Max' | 'Count' | 'Sum'

export function aggregationOperatorToString(op: AggregationOperator): string {
  switch (op) {
    case 'Min':
      return 'min'
    case 'Max':
      return 'max'
    case 'Count':
      return 'count'
    case 'Sum':
      return 'sum'
  }
}

export class Aggregation {
  constructor(
    public readonly operator: AggregationOperator,
    public readonly arithmetic: Arithmetic,
    public readonly dataType: DataType = 'Integer',
  ) {}

  vars(): string[] {
    return this.arithmetic.vars()
  }

  toString(): string {
    return `${aggregationOperatorToString(this.operator)}(${this.arithmetic.toString()})`
  }
}
