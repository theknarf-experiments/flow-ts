// `/` route — a small landing page linking to the bundled demos. Each
// demo lives at its own path so it can hold its own Store / program
// state without leaking across navigations.

import { Link, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: Landing,
})

function Landing() {
  return (
    <div className="app">
      <header>
        <h1>flow-ts • demos</h1>
        <p>
          Two small React apps built on top of <code>@flow-ts/react</code> —
          each runs a different Datalog program through the same
          incremental engine.
        </p>
      </header>

      <section className="grid">
        <Link to="/friends" className="card demo-link" data-testid="link-friends">
          <h2>Friend graph</h2>
          <p className="muted">
            Recursive reachability over a directed friend graph.
            Demonstrates EDB editing, recursive joins, and a generic
            schema-driven relation inspector with strings, ints, and
            floats.
          </p>
        </Link>

        <Link to="/text" className="card demo-link" data-testid="link-text">
          <h2>Collaborative text (RGA CRDT)</h2>
          <p className="muted">
            Stewen's list CRDT (§4.2.2) as a Datalog query. Type into a
            box; each keystroke becomes an immutable <code>Insert</code>
            op, backspace becomes a <code>Remove</code>. The rendered
            text is derived live from <code>ListElem</code>.
          </p>
        </Link>

        <Link to="/mvr" className="card demo-link" data-testid="link-mvr">
          <h2>Multi-value key-value store (MVR CRDT)</h2>
          <p className="muted">
            Stewen's MVR §4.2.1 — concurrent writes to the same key
            coexist as a set rather than overriding each other.
            Includes a toggle for the causal-broadcast variant that
            gates ops until their predecessors arrive.
          </p>
        </Link>
      </section>
    </div>
  )
}
