import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'

// Tanstack Start in SPA mode — no SSR, no server entry. The store
// holds a stateful db-ivm session that can't serialise across the
// wire, so the whole demo stays on the client.
//
// Note: we deliberately do NOT install the standalone
// `@tanstack/router-plugin/vite`. Tanstack Start already includes its
// own internal router-plugin (`tanStackStartRouter`); adding the
// standalone one on top runs the code-splitter twice over the same
// route files and trips a duplicate-`hot` declaration during HMR.
export default defineConfig({
  plugins: [
    tanstackStart({
      spa: { enabled: true },
    }),
    react(),
  ],
})
