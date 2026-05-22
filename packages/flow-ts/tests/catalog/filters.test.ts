// Tests for BaseFilters via Catalog.fromStrata on rules that exercise each
// kind of base filter.

import {
  Atom,
  type AtomArg,
  FLRule,
  Head,
  type HeadArg,
  type Predicate,
} from 'flow-ts'
import { describe, expect, it } from 'vitest'
import { Catalog } from '../../src/catalog/index.js'

function buildRule(head: Head, body: Predicate[]): FLRule {
  return new FLRule(head, body, false, false)
}

const xHead: HeadArg[] = [{ kind: 'Var', name: 'x' }]

describe('BaseFilters via Catalog.fromStrata', () => {
  it('records a var equality alias: arc(x, x)', () => {
    const arcXX: Predicate = {
      kind: 'Atom',
      atom: new Atom('arc', [
        { kind: 'Var', name: 'x' } satisfies AtomArg,
        { kind: 'Var', name: 'x' },
      ]),
    }
    const rule = buildRule(new Head('r', xHead), [arcXX])
    const cat = Catalog.fromStrata(rule)
    expect(cat.baseFilters.varEqMap.size).toBe(1)
    expect(cat.baseFilters.constMap.size).toBe(0)
    expect(cat.baseFilters.placeholderSet.size).toBe(0)
  })

  it('records a constant: arc(x, 5)', () => {
    const arcX5: Predicate = {
      kind: 'Atom',
      atom: new Atom('arc', [
        { kind: 'Var', name: 'x' },
        { kind: 'Const', value: { kind: 'Integer', value: 5 } },
      ]),
    }
    const rule = buildRule(new Head('r', xHead), [arcX5])
    const cat = Catalog.fromStrata(rule)
    expect(cat.baseFilters.constMap.size).toBe(1)
    expect(cat.baseFilters.varEqMap.size).toBe(0)
  })

  it('records a placeholder: arc(x, _)', () => {
    const arcXUnderscore: Predicate = {
      kind: 'Atom',
      atom: new Atom('arc', [
        { kind: 'Var', name: 'x' },
        { kind: 'Placeholder' },
      ]),
    }
    const rule = buildRule(new Head('r', xHead), [arcXUnderscore])
    const cat = Catalog.fromStrata(rule)
    expect(cat.baseFilters.placeholderSet.size).toBe(1)
  })

  it('isEmpty when the body has only fresh variables', () => {
    const arcXY: Predicate = {
      kind: 'Atom',
      atom: new Atom('arc', [
        { kind: 'Var', name: 'x' },
        { kind: 'Var', name: 'y' },
      ]),
    }
    const rule = buildRule(new Head('r', xHead), [arcXY])
    const cat = Catalog.fromStrata(rule)
    expect(cat.baseFilters.isEmpty()).toBe(true)
  })
})

describe('safe-variable check on negation', () => {
  it('throws when a negated atom uses an unsafe variable', () => {
    // R(x) :- A(x), !B(y).  y is not bound by any positive atom.
    const aX: Predicate = {
      kind: 'Atom',
      atom: new Atom('A', [{ kind: 'Var', name: 'x' }]),
    }
    const negBY: Predicate = {
      kind: 'NegatedAtom',
      atom: new Atom('B', [{ kind: 'Var', name: 'y' }]),
    }
    const rule = buildRule(new Head('R', xHead), [aX, negBY])
    expect(() => Catalog.fromStrata(rule)).toThrow(/unsafe var/)
  })
})
