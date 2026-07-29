// `/` — the overview. Two lists: the tutorial in order, and the demos.
//
// The tutorial is the front door now. The demos are still here, and still worth
// reading, but they answer "what can this be used for" rather than "how does
// this work", and a reader who arrives with the second question should not have
// to reverse-engineer an RGA CRDT to get an answer.

import { Link, createFileRoute } from '@tanstack/react-router'
import { Inline } from '../components/Prose.js'
import { lessonLabel, lessonOutline, type Lesson } from '../lessons/lessons.js'

export const Route = createFileRoute('/')({
  component: Landing,
})

const DEMOS = [
  {
    to: '/friends' as const,
    title: 'Friend graph',
    testid: 'link-friends',
    blurb:
      'Recursive reachability with a live-editable program, a schema-driven inspector, and one writable view.',
  },
  {
    to: '/vault' as const,
    title: 'Markdown vault',
    testid: 'link-vault',
    blurb:
      'A vault as a live notebook: notes lowered into facts, nine views derived from them, and edits to the views rewriting the markdown. Backward propagation at full size.',
  },
  {
    to: '/text' as const,
    title: 'Collaborative text (RGA CRDT)',
    testid: 'link-text',
    blurb:
      "Stewen's list CRDT (§4.2.2) as a Datalog query. Each keystroke is an immutable op; the rendered text is derived by walking a linked list the rules build. Two replicas over a flaky link.",
  },
  {
    to: '/mvr' as const,
    title: 'Multi-value register (MVR CRDT)',
    testid: 'link-mvr',
    blurb:
      "Stewen's MVR §4.2.1 — concurrent writes to one key coexist as a set instead of clobbering each other, with a toggle for the causal-broadcast variant.",
  },
]

function LessonCard({ lesson }: { lesson: Lesson }) {
  return (
    <Link
      to="/learn/$slug"
      params={{ slug: lesson.slug }}
      className="lesson-card"
      data-testid={`lesson-link-${lesson.slug}`}
    >
      <span className="lesson-card-number">{lessonLabel(lesson)}</span>
      <span className="lesson-card-body">
        <span className="lesson-card-title">{lesson.title}</span>
        <span className="lesson-card-blurb">
          <Inline text={lesson.blurb} />
        </span>
      </span>
    </Link>
  )
}

function Landing() {
  return (
    <div className="app">
      <header>
        <h1>flow-ts</h1>
        <p className="lede">
          A Datalog engine in TypeScript, on top of incremental dataflow. It parses
          a program, stratifies and plans it, and runs it as a dataflow graph whose
          operators are inherently incremental — feed it new facts and only the
          affected derivations re-run.
        </p>
        <p className="lede">
          The whole engine runs in this page. Every table in the tutorial is live:
          edit a fact, or edit the rules themselves, and watch what changes.
        </p>
      </header>

      <section className="overview-section">
        <h2>Tutorial</h2>
        <p className="muted">
          One feature at a time, each lesson using only what the ones before it
          introduced. Start at the top.
        </p>
        <ul className="lesson-list" data-testid="lesson-list">
          {lessonOutline().map(({ lesson, children }) => (
            <li key={lesson.slug}>
              <LessonCard lesson={lesson} />
              {children.length > 0 && (
                <ul className="lesson-sublist">
                  {children.map((child) => (
                    <li key={child.slug}>
                      <LessonCard lesson={child} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="overview-section">
        <h2>Demos</h2>
        <p className="muted">
          The same engine at a size the tutorial deliberately avoids.
        </p>
        <div className="grid">
          {DEMOS.map((demo) => (
            <Link key={demo.to} to={demo.to} className="card demo-link" data-testid={demo.testid}>
              <h3>{demo.title}</h3>
              <p className="muted">{demo.blurb}</p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  )
}
