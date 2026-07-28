// `/vault` route — a markdown vault as a live Datalog notebook, and the
// clearest demonstration of why backward propagation exists: the tables are
// derived, and editing one rewrites the markdown it came from.

import { createFileRoute } from '@tanstack/react-router'
import { VaultDemo } from '../VaultDemo.js'

export const Route = createFileRoute('/vault')({
  component: VaultDemo,
})
