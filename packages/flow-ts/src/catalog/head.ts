// Port of flowlog/src/catalog/src/head.rs

import type { Aggregation, Head, Program } from '../ast/index.js'

/**
 * Structural analysis of an aggregation rule head — only valid when the head
 * contains an aggregation as its last argument.
 */
export class AggregationHeadIDB {
  constructor(
    public readonly name: string,
    public readonly aggregationArgument: Aggregation,
    /** True when there's at least one grouping (non-aggregation) argument. */
    public readonly isGroupBy: boolean,
    public readonly arity: number,
  ) {}

  static fromAggregationRule(head: Head): AggregationHeadIDB {
    const args = head.headArguments
    const last = args[args.length - 1]
    if (!last || last.kind !== 'Aggregation') {
      throw new Error('Head must contain an aggregation argument')
    }
    return new AggregationHeadIDB(
      head.name,
      last.aggregation,
      args.length > 1,
      args.length,
    )
  }

  aggregation(): Aggregation {
    return this.aggregationArgument
  }
}

/**
 * Map of predicate name → AggregationHeadIDB for every rule whose head ends in
 * an aggregation. If multiple rules define the same predicate, the first one
 * encountered wins (matches the Rust HashMap semantics).
 */
export function aggregationCatalogFromProgram(
  program: Program,
): Map<string, AggregationHeadIDB> {
  const catalog = new Map<string, AggregationHeadIDB>()
  for (const rule of program.rules) {
    const head = rule.head
    const args = head.headArguments
    const last = args[args.length - 1]
    const hasAggregation = !!last && last.kind === 'Aggregation'
    if (hasAggregation && !catalog.has(head.name)) {
      catalog.set(head.name, AggregationHeadIDB.fromAggregationRule(head))
    }
  }
  return catalog
}
