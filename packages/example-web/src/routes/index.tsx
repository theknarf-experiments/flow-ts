// The `/` route. The bulk of the demo lives in `App.tsx`, which is
// imported here verbatim so the file-based routing layer stays a thin
// shell — easier to evolve and easier to skim.

import { createFileRoute } from '@tanstack/react-router'
import { App } from '../App.js'

export const Route = createFileRoute('/')({
  component: App,
})
