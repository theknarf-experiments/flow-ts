// Top-level parser. Uses a pre-generated peggy parser
// (see src/grammar.peggy → src/__generated__/grammar.js).

import { Aggregation, type AggregationOperator } from './aggregation.js'
import {
  Arithmetic,
  type ArithmeticOperator,
  type Factor,
} from './arithmetic.js'
import { ComparisonExpr, type ComparisonOperator } from './compare.js'
import type { Const } from './constant.js'
import { Attribute, type DataType, RelDecl } from './decl.js'
import { parse as peggyParse } from './__generated__/grammar.js'
import { Head, type HeadArg } from './head.js'
import { Program } from './program.js'
import { Atom, type AtomArg, FLRule, type Predicate } from './rule.js'

type Builders = {
  program: (edbs: RelDecl[], idbs: RelDecl[], rules: FLRule[]) => Program
  relDecl: (name: string, attrs: Attribute[], path: string | null) => RelDecl
  attribute: (name: string, ty: DataType) => Attribute
  rule: (head: Head, rhs: Predicate[], planning: boolean, sip: boolean) => FLRule
  predAtom: (atom: Atom) => Predicate
  predNegated: (atom: Atom) => Predicate
  predCompare: (expr: ComparisonExpr) => Predicate
  predBoolean: (value: boolean) => Predicate
  atom: (name: string, args: AtomArg[]) => Atom
  atomArgVar: (name: string) => AtomArg
  atomArgConst: (value: Const) => AtomArg
  atomArgPlaceholder: () => AtomArg
  head: (name: string, args: HeadArg[]) => Head
  headArgAgg: (agg: Aggregation) => HeadArg
  headArgFromArithmic: (a: Arithmetic) => HeadArg
  aggregation: (op: AggregationOperator, a: Arithmetic) => Aggregation
  compareExpr: (
    left: Arithmetic,
    op: ComparisonOperator,
    right: Arithmetic,
  ) => ComparisonExpr
  arithmetic: (
    init: Factor,
    rest: Array<[ArithmeticOperator, Factor]>,
  ) => Arithmetic
  factorVar: (name: string) => Factor
  factorConst: (value: Const) => Factor
  constInteger: (value: number) => Const
  constText: (value: string) => Const
}

const builders: Builders = {
  program: (edbs, idbs, rules) => new Program(edbs, idbs, rules),
  relDecl: (name, attrs, path) => new RelDecl(name, attrs, path),
  attribute: (name, ty) => new Attribute(name, ty),
  rule: (head, rhs, planning, sip) => new FLRule(head, rhs, planning, sip),
  predAtom: (atom) => ({ kind: 'Atom', atom }),
  predNegated: (atom) => ({ kind: 'NegatedAtom', atom }),
  predCompare: (expr) => ({ kind: 'Compare', expr }),
  predBoolean: (value) => {
    const zero = new Arithmetic({ kind: 'Const', value: { kind: 'Integer', value: 0 } }, [])
    const op: ComparisonOperator = value ? 'Equals' : 'NotEquals'
    return { kind: 'Compare', expr: new ComparisonExpr(zero, op, zero) }
  },
  atom: (name, args) => new Atom(name, args),
  atomArgVar: (name) => ({ kind: 'Var', name }),
  atomArgConst: (value) => ({ kind: 'Const', value }),
  atomArgPlaceholder: () => ({ kind: 'Placeholder' }),
  head: (name, args) => new Head(name, args),
  headArgAgg: (aggregation) => ({ kind: 'Aggregation', aggregation }),
  headArgFromArithmic: (a) =>
    a.isVar()
      ? { kind: 'Var', name: (a.init as { kind: 'Var'; name: string }).name }
      : { kind: 'Arith', arithmetic: a },
  aggregation: (op, a) => new Aggregation(op, a),
  compareExpr: (left, op, right) => new ComparisonExpr(left, op, right),
  arithmetic: (init, rest) => new Arithmetic(init, rest),
  factorVar: (name) => ({ kind: 'Var', name }),
  factorConst: (value) => ({ kind: 'Const', value }),
  constInteger: (value) => ({ kind: 'Integer', value }),
  constText: (value) => ({ kind: 'Text', value }),
}

export interface ParseOptions {
  /** Optional human-readable name used in parse error messages. */
  grammarSource?: string
}

export function parseProgram(source: string, options: ParseOptions = {}): Program {
  return peggyParse(source, {
    ...(options.grammarSource !== undefined ? { grammarSource: options.grammarSource } : {}),
    b: builders,
  }) as Program
}
