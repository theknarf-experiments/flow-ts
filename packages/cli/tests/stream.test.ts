// CLI streaming integration tests. Drives `runStreamCli` directly with
// a synthetic stdin iterator and an in-memory output sink, asserting
// that each tick emits the expected diff lines.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Args } from '../src/args.js'
import { runStreamCli } from '../src/main.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-ts-stream-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(name: string, content: string): string {
  const p = path.join(tmpDir, name)
  fs.writeFileSync(p, content)
  return p
}

const REACH = `\
.in
.decl Source(id: number)
.input Source.csv

.decl Arc(x: number, y: number)
.input Arc.csv

.printsize
.decl Reach(id: number)

.rule
Reach(y) :- Source(y).
Reach(y) :- Reach(x), Arc(x, y).
`

async function* lines(...xs: string[]): AsyncIterable<string> {
  for (const x of xs) yield x
}

async function runWith(linesIter: AsyncIterable<string>): Promise<string[]> {
  const programPath = write('reach.dl', REACH)
  const args = new Args({
    program: programPath,
    facts: tmpDir,
    stream: true,
  })
  const out: string[] = []
  await runStreamCli(args, linesIter, (l) => out.push(l))
  return out
}

describe('runStreamCli', () => {
  it('emits initial state then incremental diffs', async () => {
    write('Source.csv', '1\n')
    write('Arc.csv', '1,2\n2,3\n')

    const out = await runWith(lines(
      '+ Arc 3,4', '',  // tick: extend to 4
      '- Arc 2,3', '',  // tick: drop 3 and 4
      '.quit',
    ))
    expect(out).toEqual([
      '+1\tReach\t1', '+1\tReach\t2', '+1\tReach\t3',
      '+1\tReach\t4',
      '-1\tReach\t3', '-1\tReach\t4',
    ])
  })

  it('skips comments and net-zero ticks', async () => {
    write('Source.csv', '1\n')
    write('Arc.csv', '1,2\n')

    const out = await runWith(lines(
      '# a comment',
      '+ Arc 2,3', '- Arc 2,3', '',  // net-zero: should not emit anything
      '.quit',
    ))
    expect(out).toEqual(['+1\tReach\t1', '+1\tReach\t2'])
  })

  it('emits a parse error on a malformed directive', async () => {
    write('Source.csv', '1\n')
    write('Arc.csv', '1,2\n')

    const out = await runWith(lines(
      'xyz not a directive', '',
      '.quit',
    ))
    expect(out[0]).toMatch(/^\+1\tReach\t1/)
    expect(out.some((l) => l.startsWith('!\t'))).toBe(true)
  })

  it('emits a friendly error on update to an unknown relation', async () => {
    write('Source.csv', '1\n')
    write('Arc.csv', '')

    const out = await runWith(lines(
      '+ NotAnEdb 1,2', '',
      '.quit',
    ))
    expect(out.some((l) => l.startsWith('!\t') && /unknown EDB/.test(l))).toBe(true)
  })

  it('treats EOF as a final implicit advance', async () => {
    write('Source.csv', '1\n')
    write('Arc.csv', '1,2\n')

    const out = await runWith(lines(
      '+ Arc 2,3',
      // no trailing blank line / .quit — EOF should still flush.
    ))
    expect(out).toContain('+1\tReach\t3')
  })
})
