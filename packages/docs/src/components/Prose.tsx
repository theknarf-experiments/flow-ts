// Lesson prose is plain strings, so `lessons.ts` stays data rather than markup.
// Two markers are worth having in it and nothing else is: backticks for inline
// code, and *asterisks* for emphasis. Anything that wants more than that is
// long enough to belong in a demo page instead.

import { Fragment, type ReactNode } from 'react'

/** Split on the marker, keeping the delimiters, and wrap the odd segments. */
function markup(text: string, marker: string, wrap: (s: string) => ReactNode): ReactNode[] {
  return text.split(marker).map((part, i) => (i % 2 === 1 ? wrap(part) : part))
}

function inline(text: string): ReactNode {
  return markup(text, '`', (code) => <code>{code}</code>).map((part, i) => (
    <Fragment key={i}>
      {typeof part === 'string' ? markup(part, '*', (em) => <em>{em}</em>) : part}
    </Fragment>
  ))
}

/** One `<p>` per string. */
export function Prose({ paragraphs }: { paragraphs: readonly string[] }): JSX.Element {
  return (
    <>
      {paragraphs.map((text, i) => (
        <p key={i}>{inline(text)}</p>
      ))}
    </>
  )
}

/** The same markup, inline — for list items and captions. */
export function Inline({ text }: { text: string }): JSX.Element {
  return <>{inline(text)}</>
}
