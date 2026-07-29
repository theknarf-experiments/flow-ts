// Root route. In Tanstack Start, the root route renders the *entire*
// HTML document (including `<html>` and `<body>`) so the framework can
// hydrate `document` directly on the client and serialise the same
// tree to a `_shell.html` template at build time.
//
// It also owns the two things every page shares: the sidebar, which is where
// the tutorial's ordering lives, and the theme, which is applied by an inline
// script in `<head>` so the first paint is already the right colour.

import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
} from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { ThemeToggle } from '../components/ThemeToggle.js'
import { lessonLabel, lessonOutline } from '../lessons/lessons.js'
import { INIT_SCRIPT } from '../theme.js'
import '../index.css'

const DEMOS = [
  { to: '/friends', label: 'Friend graph' },
  { to: '/vault', label: 'Markdown vault' },
  { to: '/text', label: 'Text CRDT' },
  { to: '/mvr', label: 'MVR CRDT' },
] as const

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1.0' },
      { title: 'flow-ts • docs' },
    ],
    scripts: [{ children: INIT_SCRIPT }],
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
        <div className="layout">
          <SideNav />
          <main className="content">
            <Outlet />
          </main>
        </div>
        <Scripts />
      </body>
    </html>
  )
}

function SideNav() {
  // Off-canvas below the breakpoint, so the sidebar doesn't eat a phone's
  // screen. Closing on navigation is the behaviour a reader expects, and the
  // only reason this needs state at all.
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)

  return (
    <>
      <button
        type="button"
        className="sidenav-toggle"
        data-testid="sidenav-toggle"
        aria-expanded={open}
        aria-controls="sidenav"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '✕' : '☰'} <span>Menu</span>
      </button>

      <nav
        id="sidenav"
        className="sidenav"
        data-testid="sidenav"
        data-open={open ? 'true' : 'false'}
      >
        <div className="sidenav-head">
          <Link to="/" className="sidenav-brand" onClick={close}>
            flow-ts
          </Link>
          <ThemeToggle />
        </div>

        <p className="sidenav-tagline">A Datalog engine on incremental dataflow.</p>

        <div className="sidenav-section">
          <h2>Start</h2>
          <ul>
            <li>
              <Link
                to="/"
                activeOptions={{ exact: true }}
                activeProps={{ className: 'active' }}
                onClick={close}
              >
                Overview
              </Link>
            </li>
          </ul>
        </div>

        <div className="sidenav-section">
          <h2>Tutorial</h2>
          {/* Numbers come from `lessonLabel` rather than a CSS counter, because
              a refinement is numbered *within* its parent (11.2) rather than
              after it, and no counter arrangement produces that from the
              markup alone. */}
          <ul data-testid="sidenav-lessons">
            {lessonOutline().map(({ lesson, children }) => (
              <li key={lesson.slug}>
                <Link
                  to="/learn/$slug"
                  params={{ slug: lesson.slug }}
                  activeProps={{ className: 'active' }}
                  onClick={close}
                >
                  <span className="sidenav-num">{lessonLabel(lesson)}</span>
                  {lesson.title}
                </Link>
                {children.length > 0 && (
                  <ul className="sidenav-sub">
                    {children.map((child) => (
                      <li key={child.slug}>
                        <Link
                          to="/learn/$slug"
                          params={{ slug: child.slug }}
                          activeProps={{ className: 'active' }}
                          onClick={close}
                        >
                          <span className="sidenav-num">{lessonLabel(child)}</span>
                          {child.title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>

        <div className="sidenav-section">
          <h2>Demos</h2>
          <ul>
            {DEMOS.map((demo) => (
              <li key={demo.to}>
                <Link to={demo.to} activeProps={{ className: 'active' }} onClick={close}>
                  {demo.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </nav>

      {/* Tapping outside the drawer closes it. Inert on wide screens, where the
          sidebar is part of the layout rather than over it. */}
      <div
        className="sidenav-scrim"
        data-open={open ? 'true' : 'false'}
        onClick={close}
        aria-hidden="true"
      />
    </>
  )
}
