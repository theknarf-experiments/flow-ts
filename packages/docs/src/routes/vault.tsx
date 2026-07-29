// `/vault` — a markdown vault as a live Datalog notebook, and the clearest
// demonstration of why backward propagation exists: the tables are derived, and
// editing one rewrites the markdown it came from.
//
// A layout route rather than a leaf. The notes, the program and the status line
// are shared by every page; only the tables differ, and there are enough of them
// now that one page was a wall.

import { createFileRoute } from '@tanstack/react-router'
import { VaultShell } from '../vault/shell.js'

export const Route = createFileRoute('/vault')({
  component: VaultShell,
})
