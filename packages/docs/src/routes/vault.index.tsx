// `/vault` — tracing a write back to the fact behind it.

import { createFileRoute } from '@tanstack/react-router'
import { TracingPage } from '../vault/tracing.js'

export const Route = createFileRoute('/vault/')({
  component: TracingPage,
})
