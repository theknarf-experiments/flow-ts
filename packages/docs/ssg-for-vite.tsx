// Static site generation for a react-router SPA, as a Vite plugin.
//
// Adapted from theknarf-experiments/modular-svg, which took it from
// theknarf.github.io. Two fixes from that lineage are load-bearing and easy to
// lose: the `<base href>` so relative asset URLs resolve under a subpath, and
// the router `basename` so prerendered nav hrefs carry that subpath too —
// without the second, opening a sidebar link in a new tab 404s on Pages.
//
// How it works: walk the route table for the list of pages, emit each one as a
// Rollup chunk whose id ends in `.html`, and return the rendered markup from
// `load`. Vite's own HTML pipeline picks those up as entries, so the script tag
// and asset URLs inside get rewritten to the hashed builds for free.
//
// The pages are rendered in Node, which is the constraint everything upstream
// has to respect: no `window` during render, and nothing that would resolve
// differently in a browser (see `ThemeToggle`, which defers both).

import { resolve } from 'node:path'
import { renderToString } from 'react-dom/server'
import {
  createStaticHandler,
  createStaticRouter,
  StaticRouterProvider,
  type RouteObject,
} from 'react-router'
import type { Plugin, ResolvedConfig } from 'vite'

export interface SsgOptions {
  routes: RouteObject[]
  /** Client entry the generated pages load — the one that *hydrates*. */
  mainScript: string
  /** Values for dynamic segments, keyed by the segment as written in the route
   *  (`:slug`). A route with a segment that has no entry here is skipped, since
   *  there is no honest way to guess what it should be. */
  params?: Record<string, readonly string[]>
  /** Rendered to `404.html` as well, which is what GitHub Pages serves for a
   *  path that has no file. */
  notFoundPath?: string
}

/** Join two path segments without doubling or dropping slashes. */
function join(parent: string, segment: string): string {
  if (!segment) return parent || '/'
  return `${parent}/${segment}`.replace(/\/{2,}/g, '/')
}

/** Every concrete page the route table describes.
 *
 *  A layout route contributes nothing itself — it is its children that are
 *  pages — and an `index` route is the layout's own path. `*` is excluded: it
 *  matches everything, so prerendering it as a path would be meaningless, and
 *  it is handled through `notFoundPath` instead. */
export function routesToPaths(
  routes: readonly RouteObject[],
  params: Record<string, readonly string[]> = {},
  parent = '',
): string[] {
  const out: string[] = []
  for (const route of routes) {
    if (route.path === '*') continue
    const here = route.index ? parent || '/' : join(parent, route.path ?? '')
    if (route.children?.length) {
      out.push(...routesToPaths(route.children, params, here))
      continue
    }
    out.push(...expand(here, params))
  }
  return out
}

/** Replace each `:param` with every value supplied for it. */
function expand(path: string, params: Record<string, readonly string[]>): string[] {
  const match = path.match(/:[A-Za-z0-9_]+/)
  if (!match) return [path]
  const values = params[match[0]]
  if (!values) return []
  return values.flatMap((value) =>
    expand(path.replace(match[0], encodeURIComponent(value)), params),
  )
}

async function renderPage(
  path: string,
  { routes, mainScript }: SsgOptions,
  base: string,
): Promise<string> {
  // Render with the same basename the client hydrates with, so the hrefs in
  // the prerendered markup already carry the base and match after hydration.
  const baseNoSlash = base.replace(/\/+$/, '')
  const { query, dataRoutes } = createStaticHandler(routes, { basename: base })

  const url = new URL('http://localhost/')
  url.pathname = baseNoSlash + path

  const context = await query(new Request(url.href, { signal: new AbortController().signal }))
  if (context instanceof Response) throw new Error(`${path} redirected during prerender`)

  const router = createStaticRouter(dataRoutes, context)

  const markup = renderToString(
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>flow-ts • docs</title>
        {/* Relative asset and script URLs resolve against this, which is what
            makes a subpath deploy work without rewriting anything. */}
        <base href={base} />
        {/* The pre-paint theme script is *not* injected here. Vite's
            `transformIndexHtml` runs over these generated pages exactly as it
            does over `index.html`, so the plugin in `vite.config.ts` puts it in
            both — and putting it here as well produced it twice. */}
      </head>
      <body>
        <div id="root">
          {/* `hydrate={false}`: that flag exists to ship loader data to the
              client, and no route here has a loader. The client builds its own
              router from the same table. */}
          <StaticRouterProvider router={router} context={context} hydrate={false} />
        </div>
        <script type="module" src={mainScript} />
      </body>
    </html>,
  )
  return `<!doctype html>${markup}`
}

/** Where the generated page lands, expressed as a source path so Vite's HTML
 *  pipeline treats it as an entry and names the output after it. */
function idForPath(root: string, path: string): string {
  const file = `${path === '/' ? '' : path}/index.html`.replace(/\/{2,}/g, '/')
  return resolve(root, file.replace(/^\//, ''))
}

export default function ssgPlugin(options: SsgOptions): Plugin {
  const paths = routesToPaths(options.routes, options.params)
  let config: ResolvedConfig
  const pageForId = new Map<string, string>()

  return {
    name: 'ssg',

    configResolved(resolved) {
      config = resolved
      for (const path of paths) pageForId.set(idForPath(config.root, path), path)
      if (options.notFoundPath) {
        // GitHub Pages serves `404.html` for anything without a file, so the
        // catch-all route gets a real page rather than a bare server message.
        pageForId.set(resolve(config.root, '404.html'), options.notFoundPath)
      }
    },

    buildStart() {
      for (const id of pageForId.keys()) this.emitFile({ type: 'chunk', id })
    },

    // Claim the ids we invented so `load` is given the chance to fill them.
    resolveId(id) {
      return pageForId.has(id) ? id : null
    },

    async load(id) {
      const path = pageForId.get(id)
      if (path === undefined) return null
      return await renderPage(path, options, config.base)
    },
  }
}
