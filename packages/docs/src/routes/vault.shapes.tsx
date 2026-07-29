// `/vault/shapes` — views whose inverse is not a copy.

import { createFileRoute } from '@tanstack/react-router'
import { ShapesPage } from '../vault/shapes.js'

export const Route = createFileRoute('/vault/shapes')({
  component: ShapesPage,
})
