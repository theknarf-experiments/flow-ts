// Tests for AggregationHeadIDB + aggregationCatalogFromProgram.

import { parseProgram } from '@flow-ts/parsing'
import { describe, expect, it } from 'vitest'
import { AggregationHeadIDB, aggregationCatalogFromProgram } from '../../src/catalog/index.js'

describe('AggregationHeadIDB', () => {
  it('extracts a count() head with grouping', () => {
    const program = parseProgram(`\
.in
.decl A(x: number, y: number)
.input A.csv

.printsize
.decl R(x: number, c: number)

.rule
R(x, count(y)) :- A(x, y).
`)
    const head = program.rules[0]!.head
    const idb = AggregationHeadIDB.fromAggregationRule(head)
    expect(idb.name).toBe('R')
    expect(idb.isGroupBy).toBe(true)
    expect(idb.arity).toBe(2)
    expect(idb.aggregationArgument.operator).toBe('Count')
  })

  it('extracts a sum() head without grouping', () => {
    const program = parseProgram(`\
.in
.decl A(x: number)
.input A.csv

.printsize
.decl R(s: number)

.rule
R(sum(x)) :- A(x).
`)
    const head = program.rules[0]!.head
    const idb = AggregationHeadIDB.fromAggregationRule(head)
    expect(idb.isGroupBy).toBe(false)
    expect(idb.arity).toBe(1)
    expect(idb.aggregationArgument.operator).toBe('Sum')
  })

  it('throws when the head has no aggregation', () => {
    const program = parseProgram(`\
.in
.decl A(x: number)
.input A.csv

.printsize
.decl R(x: number)

.rule
R(x) :- A(x).
`)
    expect(() => AggregationHeadIDB.fromAggregationRule(program.rules[0]!.head)).toThrow(
      /aggregation/,
    )
  })
})

describe('aggregationCatalogFromProgram', () => {
  it('indexes only rules whose head ends in an aggregation', () => {
    const program = parseProgram(`\
.in
.decl A(x: number, y: number)
.input A.csv

.printsize
.decl R(x: number, c: number)
.decl P(x: number)

.rule
R(x, count(y)) :- A(x, y).
P(x) :- A(x, _).
`)
    const catalog = aggregationCatalogFromProgram(program)
    expect(catalog.size).toBe(1)
    expect(catalog.has('R')).toBe(true)
    expect(catalog.has('P')).toBe(false)
  })

  it('keeps the first rule encountered when multiple agg rules share a predicate', () => {
    const program = parseProgram(`\
.in
.decl A(x: number, y: number)
.input A.csv

.printsize
.decl R(x: number, c: number)

.rule
R(x, count(y)) :- A(x, y).
R(x, sum(y))   :- A(x, y).
`)
    const catalog = aggregationCatalogFromProgram(program)
    expect(catalog.get('R')!.aggregationArgument.operator).toBe('Count')
  })
})
