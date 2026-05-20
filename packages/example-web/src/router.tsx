import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen.js'

// Tanstack Start picks this up via the `#tanstack-router-entry` alias
// configured by the Start Vite plugin; the function must be named
// `getRouter` for the framework's hydration entry to find it.
export function getRouter() {
  return createRouter({
    routeTree,
    defaultPreload: 'intent',
    scrollRestoration: true,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
