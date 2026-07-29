import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// A plain Vite SPA. `index.html` at the package root is the entry, React mounts
// into `#root`, and `react-router`'s `createBrowserRouter` takes it from there.
//
// Nothing here opts out of server rendering, because nothing offers it. The
// demos hold stateful db-ivm sessions that don't serialise, so this was always
// client-only; the previous setup spent a framework and a code-generation step
// arriving at the same place.
//
// Vite's default `appType: 'spa'` gives history fallback in both `dev` and
// `preview`, which is what makes `/learn/recursion` work as a deep link.
export default defineConfig({
  plugins: [react()],
})
