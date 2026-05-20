// `/text` route — Stewen's RGA list CRDT (§4.2.2) driving a textarea.

import { createFileRoute } from '@tanstack/react-router'
import { TextDemo } from '../TextDemo.js'

export const Route = createFileRoute('/text')({
  component: TextDemo,
})
