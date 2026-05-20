// `/friends` route — the original friend-graph reachability demo.
// Everything still lives in `App.tsx`; this file is just the routing
// shell so the bulk of the demo stays where existing tests + readers
// expect it.

import { createFileRoute } from '@tanstack/react-router'
import { App } from '../App.js'

export const Route = createFileRoute('/friends')({
  component: App,
})
