// Root route. In Tanstack Start, the root route renders the *entire*
// HTML document (including `<html>` and `<body>`) so the framework can
// hydrate `document` directly on the client and serialise the same
// tree to a `_shell.html` template at build time.

import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from '@tanstack/react-router'
import { useEffect } from 'react'
import '../index.css'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1.0' },
      { title: 'flow-ts • friend-graph demo' },
    ],
  }),
  component: RootDocument,
})

function RootDocument() {
  // Imperatively flip `data-hydrated` on <body> once React has mounted.
  // Setting this via React state would cause the entire root document
  // to re-render, and re-rendering <html>/<body> during hydration
  // blows up with "Maximum call stack size exceeded". The e2e suite
  // waits on this attribute before clicking — without it, clicks
  // against the prerendered DOM fire before handlers are attached.
  useEffect(() => {
    document.body.setAttribute('data-hydrated', 'true')
  }, [])
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  )
}
