// Client entry. Plain Vite: `index.html` loads this, this mounts React.
//
// There is no server and no prerender — the demos hold stateful db-ivm sessions
// that don't serialise, so the whole thing has always been client-only. Saying
// so with an ordinary SPA entry is less machinery than opting a framework out
// of the rendering it exists to do.
//
// No `StrictMode`, which is a deliberate omission rather than an oversight: the
// CRDT demos drive timers and a simulated network from effects, and
// double-invoking those would change what they demonstrate. The stores are
// already written to survive it (see `lessons/Lesson.tsx`), so turning it on is
// a small, separate change if it's ever wanted.

import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router/dom'
import { router } from './routes.js'
import './index.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from index.html')

createRoot(container).render(<RouterProvider router={router} />)
