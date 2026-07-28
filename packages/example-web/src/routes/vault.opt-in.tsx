// `/vault/opt-in` — what gets compiled, and what that costs.

import { createFileRoute } from '@tanstack/react-router'
import { OptInPage } from '../vault/optin.js'

export const Route = createFileRoute('/vault/opt-in')({
  component: OptInPage,
})
