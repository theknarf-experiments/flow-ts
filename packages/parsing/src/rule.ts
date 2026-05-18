// Port of flowlog/src/parsing/src/rule.rs (Atom / AtomArg / Predicate / FLRule)

import type { ComparisonExpr } from './compare.js'
import type { Const } from './constant.js'
import { constToString } from './constant.js'
import type { Head } from './head.js'

export type AtomArg =
  | { kind: 'Var'; name: string }
  | { kind: 'Const'; value: Const }
  | { kind: 'Placeholder' }

export function atomArgIsVar(a: AtomArg): boolean {
  return a.kind === 'Var'
}

export function atomArgIsConst(a: AtomArg): boolean {
  return a.kind === 'Const'
}

export function atomArgIsPlaceholder(a: AtomArg): boolean {
  return a.kind === 'Placeholder'
}

export function atomArgAsVar(a: AtomArg): string {
  if (a.kind !== 'Var') throw new Error(`expects var: ${JSON.stringify(a)}`)
  return a.name
}

export function atomArgToString(a: AtomArg): string {
  switch (a.kind) {
    case 'Var':
      return a.name
    case 'Const':
      return constToString(a.value)
    case 'Placeholder':
      return '_'
  }
}

export class Atom {
  constructor(
    public readonly name: string,
    public readonly args: AtomArg[],
  ) {}

  arity(): number {
    return this.args.length
  }

  pushArg(arg: AtomArg): void {
    this.args.push(arg)
  }

  toString(): string {
    return `${this.name}(${this.args.map(atomArgToString).join(', ')})`
  }
}

export type Predicate =
  | { kind: 'Atom'; atom: Atom }
  | { kind: 'NegatedAtom'; atom: Atom }
  | { kind: 'Compare'; expr: ComparisonExpr }

export function predicateArguments(p: Predicate): AtomArg[] {
  switch (p.kind) {
    case 'Atom':
    case 'NegatedAtom':
      return p.atom.args
    case 'Compare':
      throw new Error('Predicate.arguments() on compare')
  }
}

export function predicateName(p: Predicate): string {
  switch (p.kind) {
    case 'Atom':
    case 'NegatedAtom':
      return p.atom.name
    case 'Compare':
      throw new Error('Predicate.name() on compare')
  }
}

export function predicateToString(p: Predicate): string {
  switch (p.kind) {
    case 'Atom':
      return p.atom.toString()
    case 'NegatedAtom':
      return `!${p.atom.toString()}`
    case 'Compare':
      return p.expr.toString()
  }
}

export class FLRule {
  constructor(
    public readonly head: Head,
    public readonly rhs: Predicate[],
    public readonly isPlanning: boolean,
    public readonly isSip: boolean,
  ) {}

  get(i: number): Predicate {
    const p = this.rhs[i]
    if (!p) throw new Error(`predicate index out of range: ${i}`)
    return p
  }

  toString(): string {
    return `${this.head.toString()} :- ${this.rhs.map(predicateToString).join(', ')}.`
  }
}
