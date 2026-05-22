// Sideways-info-passing tests using the example from the Rust reducer docstring.

import { parseProgram } from '@flow-ts/parsing'
import { describe, expect, it } from 'vitest'
import { Catalog } from '../../src/catalog/index.js'

describe('Catalog.sideways — Andersen-style example', () => {
  // From the docstring in flowlog/src/catalog/src/rule.rs:
  //   Assign(actual, formal) :-
  //     CallGraphEdge(invocation, method),
  //     ActualParam(index, invocation, actual),
  //     FormalParam(index, method, formal).
  const program = parseProgram(`\
.in
.decl CallGraphEdge(invocation: number, method: number)
.input CallGraphEdge.csv

.decl ActualParam(index: number, invocation: number, actual: number)
.input ActualParam.csv

.decl FormalParam(index: number, method: number, formal: number)
.input FormalParam.csv

.printsize
.decl Assign(actual: number, formal: number)

.rule
Assign(actual, formal) :- CallGraphEdge(invocation, method), ActualParam(index, invocation, actual), FormalParam(index, method, formal).
`)

  it('produces forward + backward sideway catalogs plus a final rewrite', () => {
    const cat = Catalog.fromStrata(program.rules[0]!)
    const sideways = cat.sideways(0)
    // 3 core atoms, 2 sideway directions per direction's 2nd+ atom (i.e. 2
    // forward sideway rules for the 2nd & 3rd atoms, plus 2 backward sideway
    // rules for the new 2nd & 3rd atoms in reverse order), and 1 final rule.
    //
    // We don't assert on the exact count because the reducer trims trivial
    // (1-atom) sideway rules; instead we check structural facts.
    expect(sideways.length).toBeGreaterThan(1)
    const final = sideways[sideways.length - 1]!
    expect(final.headName()).toBe('Assign')
    // The final rule's positive atoms should each carry a SIP suffix.
    for (const name of final.atomNames) {
      expect(name).toMatch(/_sip0[fb]\d+$/)
    }
  })

  it('forward direction names atoms with the f suffix', () => {
    const cat = Catalog.fromStrata(program.rules[0]!)
    const sideways = cat.sideways(7)
    const forwardSuffixed = sideways.filter((c) =>
      c.headName().includes('_sip7f'),
    )
    const backwardSuffixed = sideways.filter((c) =>
      c.headName().includes('_sip7b'),
    )
    expect(forwardSuffixed.length).toBeGreaterThan(0)
    expect(backwardSuffixed.length).toBeGreaterThan(0)
  })
})
