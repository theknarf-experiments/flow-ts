// Anything the route table doesn't claim.
//
// Worth having rather than a blank page: the sidebar is still there, so a
// mistyped URL leaves a reader one click from everything.

import { Link, useLocation } from 'react-router'

export function NotFound(): JSX.Element {
  const { pathname } = useLocation()
  return (
    <div className="app" data-testid="not-found">
      <header>
        <h1>Not found</h1>
        <p>
          There is nothing at <code>{pathname}</code>.
        </p>
      </header>
      <p className="muted">
        Try the <Link to="/">overview</Link>, or pick a lesson from the sidebar.
      </p>
    </div>
  )
}
