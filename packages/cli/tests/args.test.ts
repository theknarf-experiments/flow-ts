// Tests for the CLI args parser.

import { describe, expect, it } from 'vitest'
import { parseArgs } from '../src/index.js'

describe('parseArgs', () => {
  it('parses required short flags', () => {
    const a = parseArgs(['-p', 'reach.dl', '-f', 'reach'])
    expect(a.program).toBe('reach.dl')
    expect(a.facts).toBe('reach')
    expect(a.delimiter).toBe(',')
    expect(a.workers).toBe(1)
    expect(a.optLevel).toBeNull()
  })

  it('parses long flags', () => {
    const a = parseArgs([
      '--program', 'p.dl', '--facts', 'f',
      '--csvs', 'out', '--delimiter', '\t',
      '--fat-mode', '--no-sharing', '--workers', '4',
    ])
    expect(a.program).toBe('p.dl')
    expect(a.csvs).toBe('out')
    expect(a.delimiter).toBe('\t')
    expect(a.fatMode).toBe(true)
    expect(a.noSharing).toBe(true)
    expect(a.workers).toBe(4)
  })

  it('accepts -O in 0..=3', () => {
    expect(parseArgs(['-p', 'a', '-f', 'b', '-O', '0']).optLevel).toBe(0)
    expect(parseArgs(['-p', 'a', '-f', 'b', '-O', '3']).optLevel).toBe(3)
    expect(() => parseArgs(['-p', 'a', '-f', 'b', '-O', '4'])).toThrow(/-O/)
  })

  it('throws on missing required args', () => {
    expect(() => parseArgs([])).toThrow(/program/)
    expect(() => parseArgs(['-p', 'a'])).toThrow(/facts/)
  })

  it('extracts program / fact names', () => {
    const a = parseArgs(['-p', '/path/to/reach.dl', '-f', '/path/to/reach'])
    expect(a.programName()).toBe('reach')
    expect(a.factName()).toBe('reach')
  })
})
