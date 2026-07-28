// Measurement helpers.
//
// Wall-clock in a shared CI box is noise-prone, so nothing here asserts on a
// duration. What these do is make the numbers comparable within one run: warm
// up first so the JIT has settled, take the *median* of several trials rather
// than the mean (one GC pause shouldn't move the answer), and report the spread
// so an unstable measurement is visible as unstable rather than quietly wrong.

export interface Timing {
  median: number
  min: number
  max: number
}

/** Median of `trials` runs of `n` iterations, after a warm-up pass. */
export function time(fn: () => void, { n = 1, trials = 5, warmup = 2 } = {}): Timing {
  for (let i = 0; i < warmup; i++) for (let k = 0; k < n; k++) fn()
  const samples: number[] = []
  for (let t = 0; t < trials; t++) {
    const start = performance.now()
    for (let k = 0; k < n; k++) fn()
    samples.push((performance.now() - start) / n)
  }
  samples.sort((a, b) => a - b)
  return {
    median: samples[Math.floor(samples.length / 2)]!,
    min: samples[0]!,
    max: samples[samples.length - 1]!,
  }
}

const ms = (x: number): string => (x >= 1 ? `${x.toFixed(2)}ms` : `${(x * 1000).toFixed(0)}µs`)

/** A timing plus its spread, so an unstable number looks unstable. */
export function fmt(t: Timing): string {
  const spread = t.median > 0 ? (t.max - t.min) / t.median : 0
  return `${ms(t.median).padStart(8)}${spread > 0.5 ? ' (noisy)' : ''}`
}

/** Print a table with aligned columns. */
export function table(title: string, headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  )
  const line = (cells: string[]) =>
    '  ' + cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ')
  console.log(
    `\n${title}\n${line(headers)}\n  ${widths.map((w) => '-'.repeat(w)).join('  ')}\n` +
      rows.map(line).join('\n'),
  )
}

/** Ratio, for the columns where the comparison is the point. */
export const ratio = (a: number, b: number): string => (b === 0 ? '—' : `${(a / b).toFixed(1)}x`)
