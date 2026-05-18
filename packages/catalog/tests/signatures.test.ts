// Targeted tests for the signature value types and the SignatureMap/Set helpers.

import { describe, expect, it } from 'vitest'
import {
  AtomArgumentSignature,
  AtomSignature,
  SignatureMap,
  SignatureSet,
} from '../src/index.js'

describe('AtomSignature', () => {
  it('positive signature has no prefix', () => {
    expect(new AtomSignature(true, 1).toString()).toBe('1')
  })

  it('negative signature is prefixed with !', () => {
    expect(new AtomSignature(false, 1).toString()).toBe('!1')
  })
})

describe('AtomArgumentSignature', () => {
  it('renders as <atom>.<arg>', () => {
    const aSig = new AtomSignature(true, 2)
    const argSig = new AtomArgumentSignature(aSig, 3)
    expect(argSig.toString()).toBe('2.3')
    expect(argSig.isPositive()).toBe(true)
  })

  it('renders negative variant with bang', () => {
    const aSig = new AtomSignature(false, 4)
    const argSig = new AtomArgumentSignature(aSig, 0)
    expect(argSig.toString()).toBe('!4.0')
    expect(argSig.isPositive()).toBe(false)
  })
})

describe('SignatureMap', () => {
  it('keys by value, not by identity', () => {
    const sigA1 = new AtomArgumentSignature(new AtomSignature(true, 1), 0)
    const sigA2 = new AtomArgumentSignature(new AtomSignature(true, 1), 0)
    const m = new SignatureMap<string>()
    m.set(sigA1, 'hello')
    expect(m.get(sigA2)).toBe('hello')
    expect(m.has(sigA2)).toBe(true)
  })

  it('iterates back the original signature objects', () => {
    const m = new SignatureMap<number>()
    const sigs = [
      new AtomArgumentSignature(new AtomSignature(true, 0), 0),
      new AtomArgumentSignature(new AtomSignature(true, 1), 0),
    ]
    m.set(sigs[0]!, 10)
    m.set(sigs[1]!, 20)
    const seen: number[] = []
    for (const [sig, value] of m.entries()) {
      // Reconstruct the key from the iteration side.
      if (sig.atomSignature.rhsId === 0) seen.push(value + 1)
      else seen.push(value + 2)
    }
    expect(seen.sort()).toEqual([11, 22])
  })
})

describe('SignatureSet', () => {
  it('rejects duplicate-value insertions', () => {
    const s = new SignatureSet()
    const sig = new AtomArgumentSignature(new AtomSignature(true, 1), 0)
    const sig2 = new AtomArgumentSignature(new AtomSignature(true, 1), 0)
    s.add(sig)
    s.add(sig2)
    expect(s.size).toBe(1)
    expect(s.has(sig2)).toBe(true)
  })
})
