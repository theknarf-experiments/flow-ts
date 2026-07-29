// One component, every lesson.
//
// The shape is the same each time on purpose: prose, then the rules, then what
// the rules derived, then the facts they derived it from, then things to try.
// A reader who learns where to look on lesson one doesn't have to learn again,
// and a lesson is a data entry rather than a page to design.
//
// Stores are cached per slug at module scope rather than built in a `useMemo`.
// A store owns a dataflow graph and seeding it has side effects, so building
// one during render would give strict mode's double-invoke two graphs and HMR a
// new one per edit. Cached, a reader who wanders off to another lesson and
// comes back finds their edits where they left them.

import { useMemo } from 'react'
import { Link } from 'react-router'
import { parseProgram } from '@flow-ts/parsing'
import { Store, useProgram } from '@flow-ts/react'
import { RelationTable } from '../components/RelationTable.js'
import { WritableTable } from '../components/WritableTable.js'
import { QueryConsole } from '../components/QueryConsole.js'
import { ProgramPanel } from '../components/ProgramPanel.js'
import { Inline, Prose } from '../components/Prose.js'
import {
  TOP_LEVEL,
  lessonBySlug,
  lessonLabel,
  lessonNeighbours,
  subLessons,
  type Lesson as LessonData,
} from './lessons.js'

const STORES = new Map<string, Store>()

function storeFor(lesson: LessonData): Store {
  const existing = STORES.get(lesson.slug)
  if (existing) return existing
  const store = new Store(parseProgram(lesson.source, { grammarSource: `${lesson.slug}.dl` }), {
    writable: lesson.writable,
  })
  for (const [relation, rows] of Object.entries(lesson.facts)) {
    for (const row of rows) store.update(relation, [...row], +1)
  }
  store.flush()
  STORES.set(lesson.slug, store)
  return store
}

export function Lesson({ lesson }: { lesson: LessonData }): JSX.Element {
  const store = storeFor(lesson)
  // Re-render on rebuild, so a reader who adds a `.decl` sees its table appear.
  const program = useProgram(store)
  const { previous, next } = lessonNeighbours(lesson.slug)
  const parent = lesson.subOf ? lessonBySlug(lesson.subOf) : undefined
  const children = subLessons(lesson.slug)

  const writable = useMemo(() => new Set(lesson.writable ?? []), [lesson])
  const derived = program.idbs.filter((d) => !writable.has(d.name))
  const editable = program.idbs.filter((d) => writable.has(d.name))

  return (
    <div className="app lesson">
      <header>
        {/* A refinement is part of its parent rather than a step of its own, so
            it names the parent instead of claiming a place in the count. */}
        <p className="lesson-number" data-testid="lesson-number">
          {parent ? (
            <>
              Lesson {lessonLabel(lesson)}
              {' · '}
              <Link to={`/learn/${parent.slug}`}>{parent.title}</Link>
            </>
          ) : (
            <>
              Lesson {lessonLabel(lesson)} of {TOP_LEVEL.length}
            </>
          )}
        </p>
        <h1>{lesson.title}</h1>
        <ul className="chips" data-testid="lesson-teaches">
          {lesson.teaches.map((t) => (
            <li key={t}>
              <code>{t}</code>
            </li>
          ))}
        </ul>
        <div className="lesson-intro">
          <Prose paragraphs={lesson.intro} />
        </div>
        {children.length > 0 && (
          <ul className="lesson-children" data-testid="lesson-children">
            {children.map((child) => (
              <li key={child.slug}>
                <Link to={`/learn/${child.slug}`}>
                  <span className="lesson-children-num">{lessonLabel(child)}</span>
                  <span>
                    <strong>{child.title}</strong> — {child.blurb}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </header>

      <ProgramPanel store={store} source={lesson.source} grammarSource={`${lesson.slug}.dl`} />

      {editable.length > 0 && (
        <section className="inspector">
          <h2>Derived, and writable</h2>
          <p className="muted">
            Edit a cell and press Enter. The change is resolved back onto the facts
            below.
          </p>
          <div className="tables">
            {editable.map((decl) => (
              <WritableTable
                key={decl.name}
                store={store}
                program={program}
                relation={decl.name}
                writeOptions={lesson.writeOptions}
              />
            ))}
          </div>
        </section>
      )}

      {derived.length > 0 && (
        <section className="inspector">
          <h2>What the rules derived</h2>
          <p className="muted">
            Read-only — these are computed. Click a column header to sort.
          </p>
          <div className="tables">
            {derived.map((decl) => (
              <RelationTable
                key={decl.name}
                store={store}
                program={program}
                relation={decl.name}
              />
            ))}
          </div>
        </section>
      )}

      <section className="inspector">
        <h2>The facts</h2>
        <p className="muted">
          Editable — type into the bottom row to add one, click <code>×</code> to
          remove one. Everything above updates incrementally.
        </p>
        <div className="tables">
          {program.edbs.map((decl) => (
            <RelationTable
              key={decl.name}
              store={store}
              program={program}
              relation={decl.name}
              actions={(row) => (
                <button
                  aria-label={`remove ${decl.name} ${row.join(' ')}`}
                  className="row-action"
                  onClick={() => store.update(decl.name, [...row], -1)}
                >
                  ×
                </button>
              )}
            />
          ))}
        </div>
      </section>

      {lesson.console && (
        <QueryConsole
          store={store}
          initial={lesson.console.initial}
          hint={lesson.console.hint}
        />
      )}

      <section className="try-this">
        <h2>Try this</h2>
        <ol data-testid="try-this">
          {lesson.tryThis.map((item) => (
            <li key={item}>
              <Inline text={item} />
            </li>
          ))}
        </ol>
      </section>

      {lesson.notes && lesson.notes.length > 0 && (
        <section className="notes" data-testid="lesson-notes">
          <h2>Notes</h2>
          <Prose paragraphs={lesson.notes} />
        </section>
      )}

      <nav className="lesson-nav" data-testid="lesson-nav">
        {previous ? (
          <Link to={`/learn/${previous.slug}`} className="lesson-prev">
            ← {previous.title}
          </Link>
        ) : (
          <Link to="/" className="lesson-prev">
            ← Overview
          </Link>
        )}
        {next && (
          <Link to={`/learn/${next.slug}`} className="lesson-next">
            {next.title} →
          </Link>
        )}
      </nav>
    </div>
  )
}
