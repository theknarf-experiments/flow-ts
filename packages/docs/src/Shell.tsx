// The layout every page sits inside: the sidebar, which is where the tutorial's
// ordering lives, and the outlet the router fills.
//
// This used to render the entire HTML document — `<html>`, `<head>`, `<body>` —
// because the framework hydrated `document` directly. It doesn't any more:
// `index.html` is an ordinary Vite entry, React mounts into `#root`, and the
// theme script that has to beat the first paint lives in the HTML where it
// belongs.

import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet } from 'react-router'
import { ThemeToggle } from './components/ThemeToggle.js'
import { lessonLabel, lessonOutline } from './lessons/lessons.js'

const DEMOS = [
  { to: '/friends', label: 'Friend graph' },
  { to: '/vault', label: 'Markdown vault' },
  { to: '/text', label: 'Text CRDT' },
  { to: '/mvr', label: 'MVR CRDT' },
] as const

/** `NavLink`'s className takes a function; this is the only styling it needs. */
const active = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : undefined)

export function Shell(): JSX.Element {
  return (
    <>
      <div className="layout">
        <SideNav />
        <main className="content">
          <Outlet />
        </main>
      </div>
      <Hydrated />
    </>
  )
}

/** Flips `data-hydrated` on `<body>` once React has mounted.
 *
 *  The e2e suite waits on this before clicking. It mattered more when the DOM
 *  was prerendered and a click could land before the handlers were attached;
 *  with an empty `#root` there is nothing to click early, but it is still the
 *  cheapest "the app is up" signal a test can wait on, and cheaper than
 *  waiting on some particular element per page. */
function Hydrated(): null {
  useEffect(() => {
    document.body.setAttribute('data-hydrated', 'true')
  }, [])
  return null
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
          {/* `Link`, not `NavLink`: the brand is a logo, not a nav item. Given a
              string className `NavLink` appends `active` to it, and `to="/"`
              prefix-matches every page — so this silently carried an `active`
              class everywhere, and computed it differently under the static
              renderer than in the browser, which failed hydration outright. */}
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
              <NavLink to="/" end className={active} onClick={close}>
                Overview
              </NavLink>
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
                <NavLink to={`/learn/${lesson.slug}`} className={active} onClick={close}>
                  <span className="sidenav-num">{lessonLabel(lesson)}</span>
                  {lesson.title}
                </NavLink>
                {children.length > 0 && (
                  <ul className="sidenav-sub">
                    {children.map((child) => (
                      <li key={child.slug}>
                        <NavLink to={`/learn/${child.slug}`} className={active} onClick={close}>
                          <span className="sidenav-num">{lessonLabel(child)}</span>
                          {child.title}
                        </NavLink>
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
                <NavLink to={demo.to} className={active} onClick={close}>
                  {demo.label}
                </NavLink>
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
