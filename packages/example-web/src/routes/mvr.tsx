// `/mvr` route — two-replica MVR key-value store with simulated sync.

import { createFileRoute } from '@tanstack/react-router'
import { MvrDemo } from '../MvrDemo.js'

export const Route = createFileRoute('/mvr')({
  component: MvrDemo,
})
