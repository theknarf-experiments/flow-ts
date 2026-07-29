// The client entry for `vite dev` and `build:spa`: `index.html` loads this, and
// this *renders* into an empty `#root`.
//
// `ssg-main.tsx` is the same thing for the static build, where the markup is
// already there and React hydrates it instead. Two entries rather than one
// because rendering over prerendered HTML is a different operation, and
// pretending otherwise is how you get a silently discarded server render.
//
// There is still no *server*. The static build renders each page once at build
// time and ships the result; nothing runs remotely, and the db-ivm sessions the
// demos hold are built fresh in the browser as they always were.
//
// No `StrictMode`, which is a deliberate omission rather than an oversight: the
// CRDT demos drive timers and a simulated network from effects, and
// double-invoking those would change what they demonstrate. The stores are
// already written to survive it (see `lessons/Lesson.tsx`), so turning it on is
// a small, separate change if it's ever wanted.

import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { routes } from './routes.js'
import './index.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from index.html')

// `basename` tracks Vite's base so the dev server and a subpath deploy agree.
const router = createBrowserRouter(routes, { basename: import.meta.env.BASE_URL })

createRoot(container).render(<RouterProvider router={router} />)
