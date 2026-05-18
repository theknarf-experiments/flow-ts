// End-to-end CLI test: write a program + facts to disk, invoke `runCli`,
// and assert it produced the expected IDB rows.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Args } from '../src/args.js'
import { runCli } from '../src/main.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-ts-cli-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(name: string, content: string): string {
  const p = path.join(tmpDir, name)
  fs.writeFileSync(p, content)
  return p
}

describe('runCli', () => {
  it('runs reach.dl from disk and reports the right IDB cardinality', () => {
    const programPath = write(
      'reach.dl',
      `\
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
`,
    )
    write('Source.csv', '1\n')
    write('Arc.csv', '1,2\n2,3\n3,4\n')

    const counts = runCli(new Args({ program: programPath, facts: tmpDir }))
    expect(counts.get('Reach')).toBe(4)
  })

  it('writes per-IDB CSVs to --csvs when configured', () => {
    const programPath = write(
      'proj.dl',
      `\
.in
.decl Arc(x: number, y: number)
.input Arc.csv

.printsize
.decl OnlyX(x: number)

.rule
OnlyX(x) :- Arc(x, y).
`,
    )
    write('Arc.csv', '1,10\n2,20\n3,30\n')

    const csvsDir = path.join(tmpDir, 'out')
    runCli(new Args({ program: programPath, facts: tmpDir, csvs: csvsDir }))

    const content = fs.readFileSync(path.join(csvsDir, 'csvs', 'OnlyX.csv'), 'utf8')
    const lines = content.split('\n').filter((l) => l.length > 0).sort()
    expect(lines).toEqual(['1', '2', '3'])

    const sizes = fs.readFileSync(path.join(csvsDir, 'csvs', 'size.txt'), 'utf8')
    expect(sizes).toMatch(/OnlyX: 3/)
  })
})
