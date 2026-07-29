// Smoke tests for the bundled example programs in `examples/`. Each
// program is run via `runCli` against the shipped CSV facts; the
// assertion is only on cardinality (and one or two row contents) so the
// tests don't break if we tweak the seed data later.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as url from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

  it('props.dl: an `any` column carries both kinds and joins by value', () => {
    const counts = runExample('props')
    // Two `born` rows, both numeric.
    expect(counts.get('Born')).toBe(2)
    // alice, bob and carol have a text city that matches City.name. dave's is
    // the *number* 1 — read that way from the fact file — so it joins nothing.
    expect(counts.get('Country')).toBe(3)
    // 2026 - 1991 >= 18 for alice; bob was born in 2015. Arithmetic works on an
    // `any` cell that happens to hold a number.
    expect(counts.get('Adult')).toBe(1)
  })

  it('payroll.dl: a `?-` query derives the same rows as the long form', () => {
    const counts = runExample('payroll')
    // Three departments, and the query form agrees with the declared one.
    expect(counts.get('Payroll')).toBe(3)
    expect(counts.get('PayrollQ')).toBe(counts.get('Payroll'))
    // Two `?-` rules over one head: eng (2) ∪ ops (1).
    expect(counts.get('Core')).toBe(3)
    // The bare goal lands in a generated relation, reporting every variable it
    // binds. alice (140), bob (120) and dave (110) clear 100; carol is on 95.
    expect(counts.get('Query1')).toBe(3)
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

  it('mvr_cb.dl: causal-broadcast variant matches mvr.dl in causal order', () => {
    // With the shared Set.csv / Pred.csv (delivered in causal order)
    // every Set op is causally ready, so the gap-detection adds no
    // extra filtering vs. mvr.dl.
    const counts = runExample('mvr_cb')
    expect(counts.get('MvrStore')).toBe(3)
    expect(counts.get('IsRoot')).toBe(3)
    expect(counts.get('IsLeaf')).toBe(3)
    expect(counts.get('IsCausallyReady')).toBe(6)
  })

  it('list_crdt.dl: thesis tree yields a 6-element linked list (HELLO!)', () => {
    // Seed inserts encode the "HELLO!" tree from thesis figure 4.6.
    // Walking ListElem from (0, 0) and collecting the value column
    // yields H, E, L, L, O, ! — see the thesis §4.2.2 example.
    const counts = runExample('list_crdt')
    expect(counts.get('ListElem')).toBe(6)
    expect(counts.get('HasValue')).toBe(7) // 6 inserts + sentinel
  })
})

describe('list_crdt deletion (thesis example continued)', () => {
  // Reuses the "HELLO!" Insert.csv from `examples/` and supplies a
  // custom Remove.csv per test. Same two steps the thesis walks
  // through after the initial state.
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-ts-list-'))
    fs.copyFileSync(
      path.join(EXAMPLES, 'Insert.csv'),
      path.join(tmpDir, 'Insert.csv'),
    )
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function runList(removeCsv: string): Map<string, number> {
    fs.writeFileSync(path.join(tmpDir, 'Remove.csv'), removeCsv)
    return runCli(
      new Args({
        program: path.join(EXAMPLES, 'list_crdt.dl'),
        facts: tmpDir,
      }),
    )
  }

  it('removing "!" leaves 5 visible elements ("HELLO")', () => {
    const counts = runList('2,2\n')
    expect(counts.get('ListElem')).toBe(5)
    expect(counts.get('HasValue')).toBe(6)
  })

  it('removing "!" and "H" leaves 4 visible elements ("ELLO")', () => {
    // Two tombstones. After skipping them, (0, 0) points directly at
    // (2, 3) whose value is 'E', then the rest of the list continues.
    const counts = runList('2,2\n2,1\n')
    expect(counts.get('ListElem')).toBe(4)
    expect(counts.get('HasValue')).toBe(5)
  })
})

describe('mvr_cb gap detection', () => {
  // Manufacture a "missing predecessor" scenario: Pred references an op
  // (1, 1) that isn't in Set, so the leaves (1, 2) and (2, 2) have no
  // path back to a root. mvr.dl (no causal broadcast) accepts them
  // anyway; mvr_cb.dl correctly drops them.
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-ts-mvr-cb-'))
    fs.writeFileSync(
      path.join(tmpDir, 'Set.csv'),
      '1,2,k1,v2\n2,2,k1,v3\n',
    )
    // Both Pred edges reference (1, 1) as the source — but (1, 1) is
    // missing from Set, so neither leaf can be reached from a root.
    fs.writeFileSync(
      path.join(tmpDir, 'Pred.csv'),
      '1,1,1,2\n1,1,2,2\n',
    )
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function runFrom(program: string): Map<string, number> {
    return runCli(
      new Args({
        program: path.join(EXAMPLES, `${program}.dl`),
        facts: tmpDir,
      }),
    )
  }

  it('mvr.dl publishes both leaves despite the missing predecessor', () => {
    const counts = runFrom('mvr')
    expect(counts.get('MvrStore')).toBe(2)
  })

  it('mvr_cb.dl drops both leaves: no causal path to a root', () => {
    const counts = runFrom('mvr_cb')
    // Empty IDBs never appear in the counts map — absence == zero rows.
    expect(counts.get('MvrStore') ?? 0).toBe(0)
    // No Set op is also a root (both are Pred targets), so IsRoot is
    // empty and the recursion has nothing to expand.
    expect(counts.get('IsRoot') ?? 0).toBe(0)
    expect(counts.get('IsCausallyReady') ?? 0).toBe(0)
  })
})
