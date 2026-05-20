// Smoke tests for the bundled example programs in `examples/`. Each
// program is run via `runCli` against the shipped CSV facts; the
// assertion is only on cardinality (and one or two row contents) so the
// tests don't break if we tweak the seed data later.

import * as path from 'node:path'
import * as url from 'node:url'
import { describe, expect, it } from 'vitest'
import { Args } from '../src/args.js'
import { runCli } from '../src/main.js'

const HERE = path.dirname(url.fileURLToPath(import.meta.url))
const EXAMPLES = path.resolve(HERE, '..', '..', '..', 'examples')

function runExample(name: string): Map<string, number> {
  return runCli(
    new Args({
      program: path.join(EXAMPLES, `${name}.dl`),
      facts: EXAMPLES,
    }),
  )
}

describe('bundled example programs', () => {
  it('friends.dl: joins names through a 2-hop friendship graph', () => {
    const counts = runExample('friends')
    // Friend hops: 1→2→3, 2→3→4. Both name endpoints are distinct.
    expect(counts.get('FoaF')).toBe(2)
  })

  it('stocks.dl: head arithmetic over a float × int works', () => {
    const counts = runExample('stocks')
    expect(counts.get('MarketCap')).toBe(3)
  })

  it('taxonomy.dl: recursive closure over string keys', () => {
    const counts = runExample('taxonomy')
    // 6 direct + 4 transitive (fruit → {fuji, granny-smith, lemon, orange}).
    expect(counts.get('Descendant')).toBe(10)
  })

  it('mvr.dl: multi-value register surfaces non-overwritten writes', () => {
    // Stewen thesis §4.2.1. Six set ops on two keys (k1, k2); four causal
    // edges retract three of them; survivors are the concurrent winners.
    // Expected MvrStore = {(k1, v2), (k1, v3), (k2, u3)}.
    const counts = runExample('mvr')
    expect(counts.get('MvrStore')).toBe(3)
    expect(counts.get('Overwritten')).toBe(3)
  })
})
