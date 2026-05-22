// Port of the property_tests module in flowlog/src/strata/src/stratification.rs

import {
  Atom,
  type AtomArg,
  FLRule,
  Head,
  type HeadArg,
  Program,
  type Predicate,
  RelDecl,
} from 'flow-ts'
import { describe, expect, it } from 'vitest'
import { Strata } from '../../src/strata/index.js'

function makeRule(headName: string, bodyAtomNames: string[]): FLRule {
  const headArgs: HeadArg[] = [{ kind: 'Var', name: 'X' }]
  const head = new Head(headName, headArgs)
  const rhs: Predicate[] = bodyAtomNames.map((name) => ({
    kind: 'Atom',
    atom: new Atom(name, [{ kind: 'Var', name: 'X' } satisfies AtomArg]),
  }))
  return new FLRule(head, rhs, false, false)
}

function makeNegRule(
  headName: string,
  posAtoms: string[],
  negAtoms: string[],
): FLRule {
  const head = new Head(headName, [{ kind: 'Var', name: 'X' }])
  const rhs: Predicate[] = posAtoms.map((name) => ({
    kind: 'Atom',
    atom: new Atom(name, [{ kind: 'Var', name: 'X' }]),
  }))
  for (const name of negAtoms) {
    rhs.push({
      kind: 'NegatedAtom',
      atom: new Atom(name, [{ kind: 'Var', name: 'X' }]),
    })
  }
  return new FLRule(head, rhs, false, false)
}

function makeProgram(rules: FLRule[]): Program {
  return new Program([] as RelDecl[], [] as RelDecl[], rules)
}

function findStratumOf(strata: Strata, headName: string): number {
  const all = strata.strata()
  for (let idx = 0; idx < all.length; idx++) {
    for (const rule of all[idx]!) {
      if (rule.head.name === headName) return idx
    }
  }
  throw new Error(`head name '${headName}' not found in any stratum`)
}

describe('Strata', () => {
  it('partition is complete (every rule appears once)', () => {
    const program = makeProgram([
      makeRule('a', ['b']),
      makeRule('b', ['c']),
      makeRule('c', []),
    ])
    const strata = Strata.fromParser(program)
    const all = strata.strata()
    const seen = new Set<string>()
    let total = 0
    for (const stratum of all) {
      for (const rule of stratum) {
        const name = rule.head.name
        expect(seen.has(name)).toBe(false)
        seen.add(name)
        total++
      }
    }
    expect(total).toBe(3)
  })

  it('has no duplicates across strata', () => {
    const program = makeProgram([
      makeRule('a', []),
      makeRule('b', ['a']),
      makeRule('c', ['a']),
      makeRule('d', ['b', 'c']),
    ])
    const strata = Strata.fromParser(program)
    const heads = strata
      .strata()
      .flatMap((stratum) => stratum.map((r) => r.head.name))
    expect(new Set(heads).size).toBe(heads.length)
  })

  it('acyclic chain produces correct stratum order', () => {
    // a ← b, b ← c: c's stratum ≤ b's ≤ a's
    const program = makeProgram([
      makeRule('a', ['b']),
      makeRule('b', ['c']),
      makeRule('c', []),
    ])
    const strata = Strata.fromParser(program)
    const sa = findStratumOf(strata, 'a')
    const sb = findStratumOf(strata, 'b')
    const sc = findStratumOf(strata, 'c')
    expect(sc).toBeLessThanOrEqual(sb)
    expect(sb).toBeLessThanOrEqual(sa)
  })

  it('self-loop is marked recursive', () => {
    // a ← a should be recursive
    const program = makeProgram([makeRule('a', ['a'])])
    const strata = Strata.fromParser(program)
    expect(strata.isRecursiveStratum(0)).toBe(true)
  })

  it('mutual recursion lands in one stratum, marked recursive', () => {
    // a ← b, b ← a
    const program = makeProgram([makeRule('a', ['b']), makeRule('b', ['a'])])
    const strata = Strata.fromParser(program)
    const sa = findStratumOf(strata, 'a')
    const sb = findStratumOf(strata, 'b')
    expect(sa).toBe(sb)
    expect(strata.isRecursiveStratum(sa)).toBe(true)
  })

  it('independent non-recursive rules are merged into one stratum', () => {
    const program = makeProgram([makeRule('a', []), makeRule('b', [])])
    const strata = Strata.fromParser(program)
    const sa = findStratumOf(strata, 'a')
    const sb = findStratumOf(strata, 'b')
    expect(sa).toBe(sb)
  })

  it('negation forces a later stratum', () => {
    // a ← ¬b: a must come after b
    const program = makeProgram([
      makeNegRule('a', [], ['b']),
      makeRule('b', []),
    ])
    const strata = Strata.fromParser(program)
    const sa = findStratumOf(strata, 'a')
    const sb = findStratumOf(strata, 'b')
    expect(sa).toBeGreaterThan(sb)
  })

  it('recursive bitmap matches strata count', () => {
    const program = makeProgram([
      makeRule('a', ['b']),
      makeRule('b', []),
      makeRule('c', ['c']),
    ])
    const strata = Strata.fromParser(program)
    expect(strata.isRecursiveStrataBitmap.length).toBe(strata.strata().length)
  })
})
