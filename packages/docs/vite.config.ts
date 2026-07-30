import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defineConfig, type Plugin, type ResolvedConfig } from 'vite'
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
  plugins: [react(), themeScript(), directoryIndex()],
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

/** Serve `/learn/facts` from `learn/facts/index.html` in `vite preview`.
 *
 *  Without this, `preview` finds no file at an extensionless path and falls
 *  through to the SPA fallback, which serves `dist/index.html` — the overview
 *  page — for *every* deep link. The client router then renders the right page
 *  over the wrong markup, so React discards the prerender and re-renders. It
 *  looks like a hydration bug in the app and is actually the preview server
 *  answering a different question than the one asked.
 *
 *  GitHub Pages resolves directory indexes itself (by redirecting to the
 *  trailing-slash form), so this only ever mattered locally — which is exactly
 *  what makes it worth fixing: preview is where the static build gets checked,
 *  and it was the one place that couldn't check it. Rewriting rather than
 *  redirecting keeps the URL the page was rendered for, so hydration is
 *  compared against the same location the prerender used.
 *
 *  `dev` needs none of this: there are no prerendered files, and falling back to
 *  `index.html` is the right answer there. */
function directoryIndex(): Plugin {
  let config: ResolvedConfig
  return {
    name: 'directory-index',
    configResolved(resolved) {
      config = resolved
    },
    configurePreviewServer(server) {
      const outDir = resolve(config.root, config.build.outDir)
      // Added directly rather than in the returned post-hook, so it runs before
      // Vite's static-file and SPA-fallback middlewares.
      server.middlewares.use((req, _res, next) => {
        const url = req.url
        if (!url || req.method !== 'GET') return next()
        const [pathname, query = ''] = url.split('?') as [string, string?]
        if (pathname.endsWith('/') || /\.[a-z0-9]+$/i.test(pathname)) return next()
        // Whether `base` is still on the URL depends on where Vite ordered its
        // own base-stripping middleware relative to this one, and that is not
        // something to depend on — so accept either form.
        const relative = pathname.startsWith(config.base)
          ? pathname.slice(config.base.length - 1)
          : pathname
        if (!existsSync(join(outDir, relative, 'index.html'))) return next()
        req.url = `${pathname}/index.html${query ? `?${query}` : ''}`
        next()
      })
    },
  }
}
