// The client entry for the *static* build.
//
// The difference from `main.tsx` is `hydrateRoot` rather than `createRoot` —
// React attaches to the markup already in the document instead of throwing it
// away. Getting that wrong doesn't fail loudly; it quietly wastes the prerender.
//
// The wait before hydrating is the part that isn't boilerplate. Every route
// below the shell is `lazy`, so on a cold load the router cannot say what to
// render until it has fetched the matched route's chunk — and a data router
// renders nothing at all until then. Hydrating into that gap would hand React
// an empty tree to reconcile against a full page, which it resolves by throwing
// the prerendered markup away: the exact outcome the static build exists to
// avoid. So we let the router finish matching first. It is one network round
// trip that the browser has already started, and the page on screen in the
// meantime is the prerendered one.
//
// The `basename` has to match the one the pages were rendered with, or every
// route matches nothing after hydration.

import { hydrateRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { routes } from './routes.js'
import './index.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from the prerendered page')

const router = createBrowserRouter(routes, { basename: import.meta.env.BASE_URL })

const hydrate = () => {
  console.log('HYDRATE', JSON.stringify({
    url: window.location.pathname,
    routerPath: router.state.location.pathname,
    initialized: router.state.initialized,
    matches: router.state.matches.map((m) => m.pathname),
  }))
  hydrateRoot(container, <RouterProvider router={router} />)
}

if (router.state.initialized) {
  hydrate()
} else {
  const stop = router.subscribe((state) => {
    if (!state.initialized) return
    stop()
    hydrate()
  })
}
