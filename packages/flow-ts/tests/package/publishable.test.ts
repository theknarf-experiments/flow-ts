// Properties of the package as something other people install.
//
// The rest of the suite tests the engine. This tests the envelope, and it exists
// because one broken byte in it made the published types unusable for a whole
// class of consumer while every other test passed.
//
// `src/db-ivm/operators/topK.ts` imported `'../types'` without the extension.
// Under `moduleResolution: bundler` — Vite, webpack, this repo's own docs site —
// that resolves fine, so nothing here noticed. Under `node16`/`nodenext`, which
// is what a TypeScript library consumer on Node should be using, it is an error
// in a `.d.ts` we shipped, and it takes the whole import down with it.

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as url from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = path.dirname(url.fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(HERE, '..', '..')
const SRC = path.join(PKG_ROOT, 'src')

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [full] : []
  })
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'),
) as Record<string, unknown>

describe('every relative import carries its extension', () => {
  // ESM requires it, and so does TypeScript once it is resolving like ESM. A
  // bundler papering over it is not a reason to omit it.
  const offenders: string[] = []
  for (const file of sourceFiles(SRC)) {
    const text = fs.readFileSync(file, 'utf8')
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*'(\.[^']*)'/g)) {
      const specifier = match[1]!
      if (!/\.(js|json|css)$/.test(specifier)) {
        offenders.push(`${path.relative(PKG_ROOT, file)} → ${specifier}`)
      }
    }
  }

  it('holds across the whole package', () => {
    expect(offenders).toEqual([])
  })
})

describe('the manifest says what npm needs it to say', () => {
  it.each([
    'name',
    'version',
    'description',
    'license',
    'repository',
    'types',
    'exports',
    'files',
  ])('declares %s', (field) => {
    expect(manifest[field]).toBeTruthy()
  })

  it('ships a licence beside the vendored fork, not only the package one', () => {
    // The old `@flow-ts/db-ivm` listed LICENSE in `files` and never had one, so
    // MIT code was being redistributed without its notice.
    expect(fs.existsSync(path.join(PKG_ROOT, 'LICENSE'))).toBe(true)
    expect(fs.existsSync(path.join(SRC, 'db-ivm', 'LICENSE'))).toBe(true)
  })

  it('ships a README, so the npm page is not blank', () => {
    expect(fs.existsSync(path.join(PKG_ROOT, 'README.md'))).toBe(true)
  })

  it('resolves types before the runtime entry', () => {
    // Condition order in `exports` is significant: `types` has to come first or
    // a resolver takes `default` and finds no declarations.
    const root = (manifest.exports as Record<string, Record<string, string>>)['.']!
    expect(Object.keys(root)[0]).toBe('types')
  })

  it('declares no dependency the published tree cannot reach', () => {
    // `src` and `dist` ship; nothing else does. A runtime dependency on a
    // workspace package would therefore be unresolvable once installed.
    const deps = Object.entries((manifest.dependencies ?? {}) as Record<string, string>)
    expect(deps.filter(([, range]) => range.startsWith('workspace:'))).toEqual([])
  })
})
