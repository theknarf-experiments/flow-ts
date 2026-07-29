// `/learn/$slug` — every tutorial lesson, through one route.
//
// The lessons are data, so there is nothing per-lesson to register here: adding
// an entry to `LESSONS` adds a page and a sidebar link.

import { Link, createFileRoute } from '@tanstack/react-router'
import { Lesson } from '../lessons/Lesson.js'
import { LESSONS, lessonBySlug } from '../lessons/lessons.js'

export const Route = createFileRoute('/learn/$slug')({
  component: LessonRoute,
})

function LessonRoute() {
  const { slug } = Route.useParams()
  const lesson = lessonBySlug(slug)

  if (!lesson) {
    return (
      <div className="app">
        <header>
          <h1>No such lesson</h1>
          <p>
            There is no lesson called <code>{slug}</code>.
          </p>
        </header>
        <ul>
          {LESSONS.map((l) => (
            <li key={l.slug}>
              <Link to="/learn/$slug" params={{ slug: l.slug }}>
                {l.title}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  // Keyed on the slug so navigating between lessons remounts rather than
  // reusing the tree — each lesson has its own store, and a component that
  // survives the swap would keep the previous one's local state.
  return <Lesson key={lesson.slug} lesson={lesson} />
}
