import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The workspace packages we import are ESM and ship type definitions, so
// Vite can pick them up directly without extra resolver config.
export default defineConfig({
  plugins: [react()],
})
