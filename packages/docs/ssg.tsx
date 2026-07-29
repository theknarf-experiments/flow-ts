#!/usr/bin/env -S vite-node --script
//
// The static build. `pnpm build` runs this instead of `vite build`.
//
// It has to be a script rather than a plugin entry in `vite.config.ts` because
// the plugin needs the *route table* — a TSX module importing every page — and
// a config file is loaded before Vite can transform that. `vite-node` runs this
// file through Vite's own pipeline, so importing `./src/routes.tsx` here just
// works, and the config is then extended with the plugin that knows the routes.
//
// `build:spa` remains the plain `vite build` for when you want a single
// `index.html` and no prerender.

import { build } from 'vite'
import { LESSONS } from './src/lessons/lessons.js'
import { routes } from './src/routes.js'
import ssgPlugin from './ssg-for-vite.js'
import viteConfig from './vite.config.js'

// Vite's `build()` API does not imply a production `NODE_ENV` the way the CLI
// does, and React reads that to pick its development or production build. Left
// unset the client bundle silently ships development React — 469 kB against
// 277 kB, with the warnings and the slow paths — and nothing fails, so the only
// symptom is a bundle that is quietly twice the size it should be.
process.env.NODE_ENV = process.env.SSG_DEV ? 'development' : 'production'

const config =
  typeof viteConfig === 'function'
    ? viteConfig({ command: 'build', mode: 'production' })
    : viteConfig

await build({
  ...config,
  // Without this Vite loads `vite.config.ts` *as well*, and every plugin in it
  // runs twice — which showed up as the theme script injected into each page
  // twice over, and meant `@vitejs/plugin-react` was transforming everything
  // twice for good measure. We are supplying the config, so say so.
  configFile: false,
  // `SSG_DEV=1` builds against development React, unminified. Hydration
  // mismatches are reported as numbered production errors otherwise, which name
  // neither the component nor the attribute — and this is the only way to find
  // out which. Kept because it took a while to work out the first time.
  ...(process.env.SSG_DEV ? { mode: 'development', build: { minify: false } } : {}),
  plugins: [
    ssgPlugin({
      routes,
      mainScript: '/src/ssg-main.tsx',
      // The one dynamic segment in the table. Enumerated from the same array
      // the sidebar reads, so a new lesson is a new page with nothing to
      // remember.
      params: { ':slug': LESSONS.map((lesson) => lesson.slug) },
      notFoundPath: '/__404__',
    }),
    ...(config.plugins ?? []),
  ],
})
