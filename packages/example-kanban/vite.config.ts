import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Pure Vite + React SPA. No Tanstack Start, no SSR — the engine
// holds a stateful db-ivm session that can't serialise across the
// wire. WebTransport requires HTTPS / HTTP/3 in the browser, so we
// serve the dev page over plain HTTP and let the page connect out
// to https://localhost:4433 (the WebTransport server). The browser
// permits that as long as the page is loaded with the right
// origin-isolation policy.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
  },
})
