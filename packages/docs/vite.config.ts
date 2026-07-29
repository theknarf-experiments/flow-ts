import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { INIT_SCRIPT } from './src/theme.js'

// A plain Vite SPA that also builds to static pages. `index.html` is the entry
// for `dev` and `build:spa`; `pnpm build` runs `./ssg.tsx`, which prerenders one
// page per route (see `ssg-for-vite.tsx`).
//
// `base` is `/` locally and `/<repo>/` on GitHub Pages, which the deploy
// workflow sets through `DOCS_BASE`. Everything that has to agree with it —
// the `<base href>` in the generated pages, the router's `basename` — reads it
// from Vite rather than repeating it.
export default defineConfig({
  base: process.env.DOCS_BASE || '/',
  plugins: [react(), themeScript()],
})

/** Inlines the pre-paint theme script into `index.html`.
 *
 *  The static pages get the same script from `ssg.tsx`, which passes the same
 *  constant. Injecting rather than hand-copying it into the HTML is what keeps
 *  `src/theme.ts` the only place it is written: a copy in `index.html` would
 *  drift from the copy the prerender uses, and the symptom — one frame of the
 *  wrong palette, in one of the two builds — is exactly the kind of thing
 *  nobody notices for months. */
function themeScript() {
  return {
    name: 'theme-init-script',
    transformIndexHtml() {
      return [
        {
          tag: 'script',
          children: INIT_SCRIPT,
          injectTo: 'head-prepend' as const,
        },
      ]
    },
  }
}
