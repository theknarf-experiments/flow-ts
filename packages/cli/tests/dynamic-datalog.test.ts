// Regression tests for the McSherry dynamic-datalog programs ported
// under `examples/dynamic-datalog/`. Each test has two parts:
//   1. A fast smoke against the bundled small sample data (always
//      runs; pins exact output cardinalities so engine regressions
//      get caught).
//   2. A full-data run against the unzipped McSherry inputs at
//      `~/projects/dynamic-datalog/problems/<name>/input/input/`,
//      skipped if that path doesn't exist on the host (mirrors the
//      vs-Rust oracle's "skip if the binary isn't there" convention).

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as url from 'node:url'
import { describe, expect, it } from 'vitest'
import { Args } from '../src/args.js'
import { runCli } from '../src/main.js'

const HERE = path.dirname(url.fileURLToPath(import.meta.url))
const EXAMPLES = path.resolve(HERE, '..', '..', '..', 'examples', 'dynamic-datalog')

function findFullDataDir(name: string): string | null {
  const candidates = [
    process.env.DYNAMIC_DATALOG_DIR
      ? path.join(process.env.DYNAMIC_DATALOG_DIR, 'problems', name, 'input', 'input')
      : null,
    path.join(os.homedir(), 'projects', 'dynamic-datalog', 'problems', name, 'input', 'input'),
  ]
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c
  }
  return null
}

describe('galen — McSherry dynamic-datalog', () => {
  it('runs against the bundled sample (1k rows per EDB)', () => {
    const counts = runCli(
      new Args({
        program: path.join(EXAMPLES, 'galen.dl'),
        facts: path.join(EXAMPLES, 'galen-sample'),
      }),
    )
    // Regression baseline. If the engine starts producing different
    // numbers, something changed.
    expect(counts.get('OutP')).toBe(1147)
    expect(counts.get('OutQ')).toBe(7865)
  })

  const fullData = findFullDataDir('galen')
  const runFull = process.env.RUN_FULL_DYNAMIC_DATALOG === '1'
  it.skipIf(!fullData || !runFull)('runs against the full McSherry input (set RUN_FULL_DYNAMIC_DATALOG=1)', () => {
    const counts = runCli(
      new Args({
        program: path.join(EXAMPLES, 'galen.dl'),
        facts: fullData!,
      }),
    )
    // Headline: OutP and OutQ are large but bounded. Just assert they
    // grew past the sample baseline — the full set has ~1M input rows
    // and the engine takes minutes, so we don't pin exact numbers.
    expect(counts.get('OutP') ?? 0).toBeGreaterThan(10_000)
    expect(counts.get('OutQ') ?? 0).toBeGreaterThan(10_000)
  }, 600_000)
})

describe('crdt — McSherry dynamic-datalog', () => {
  it('runs against the bundled sample (500 inserts + matching removes)', () => {
    const counts = runCli(
      new Args({
        program: path.join(EXAMPLES, 'crdt.dl'),
        facts: path.join(EXAMPLES, 'crdt-sample'),
        delimiter: ' ',
      }),
    )
    // Regression baseline — derived from running the engine once. If
    // the engine's output drifts we'll see it here.
    expect(counts.get('Result')).toBe(207)
  })

  const fullData = findFullDataDir('crdt')
  const runFull = process.env.RUN_FULL_DYNAMIC_DATALOG === '1'
  it.skipIf(!fullData || !runFull)('runs against the full McSherry input (set RUN_FULL_DYNAMIC_DATALOG=1)', () => {
    const counts = runCli(
      new Args({
        program: path.join(EXAMPLES, 'crdt.dl'),
        facts: fullData!,
        delimiter: ' ',
      }),
    )
    expect(counts.get('Result') ?? 0).toBeGreaterThan(0)
  }, 600_000)
})
