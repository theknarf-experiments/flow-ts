// The route table.
//
// One file instead of nine. File-based routing bought a directory of one-line
// modules whose only job was to name a component — `routes/text.tsx` existed to
// say that `/text` renders `<TextDemo>` — and the comments explaining *why* a
// route was shaped a certain way had nowhere better to live than those stubs.
// Written out, the shape of the site is one thing you can read.
//
// Everything below the shell is `lazy`, which is doing real work here rather
// than being a reflex. The overview needs no engine at all, and each demo pulls
// its own program, its seed data and — for the CRDTs — a simulated network. Left
// eager they are one 530 kB chunk that every visitor downloads to read a
// sentence about Datalog. Split, the first paint carries the shell and the
// lesson index, and a demo costs what that demo costs.
//
// `lazy` returns the route's component, and the router awaits it before
// rendering, so there is no flash of a half-built page and no `Suspense`
// boundary to place. The static generator gets the same treatment for free:
// `createStaticHandler` resolves the module before it renders, so a prerendered
// page is complete rather than a shell.

import type { RouteObject } from 'react-router'
import { Shell } from './Shell.js'
import { NotFound } from './pages/NotFound.js'

/** The route table itself, not a router built from it.
 *
 *  Two things consume this: the browser entry, which wraps it in a
 *  `createBrowserRouter`, and the static generator, which walks it for the list
 *  of pages to render and hands it to `createStaticHandler`. Exporting the
 *  array is what lets those two agree by construction. */
export const routes: RouteObject[] = [
  {
    // The sidebar and the theme, shared by everything — and the only thing
    // loaded eagerly.
    element: <Shell />,
    children: [
      {
        index: true,
        lazy: async () => ({ Component: (await import('./pages/Overview.js')).Overview }),
      },

      // Every tutorial lesson, through one route. The lessons are data, so
      // adding one adds a page without touching this file.
      {
        path: 'learn/:slug',
        lazy: async () => ({ Component: (await import('./pages/LessonPage.js')).LessonPage }),
      },

      // The friend-graph demo: recursive reachability, a live-editable
      // program, and one writable view.
      { path: 'friends', lazy: async () => ({ Component: (await import('./App.js')).App }) },

      // Stewen's RGA list CRDT (§4.2.2) driving a textarea.
      {
        path: 'text',
        lazy: async () => ({ Component: (await import('./TextDemo.js')).TextDemo }),
      },

      // Two-replica MVR key-value store with simulated sync.
      { path: 'mvr', lazy: async () => ({ Component: (await import('./MvrDemo.js')).MvrDemo }) },

      // The vault is a layout, not a leaf: the notes, the program and the
      // status line are shared by every page under it and only the tables
      // differ, which is why `VaultShell` renders an `<Outlet>`.
      {
        path: 'vault',
        lazy: async () => ({ Component: (await import('./vault/shell.js')).VaultShell }),
        children: [
          {
            index: true,
            lazy: async () => ({ Component: (await import('./vault/tracing.js')).TracingPage }),
          },
          {
            path: 'shapes',
            lazy: async () => ({ Component: (await import('./vault/shapes.js')).ShapesPage }),
          },
          {
            path: 'opt-in',
            lazy: async () => ({ Component: (await import('./vault/optin.js')).OptInPage }),
          },
        ],
      },

      { path: '*', element: <NotFound /> },
    ],
  },
]

export default routes
