// Type a program, run it over the facts the store already holds.
//
// `useAdHocQuery` evaluates in a throwaway session rather than splicing the
// rules into the live program — a scratch query shouldn't rebuild everyone
// else's graph. That makes it a batch run, re-run whenever the facts change,
// which is the right price for a console someone is looking at and the wrong
// one for anything on a hot path.
//
// Parse errors render instead of throwing, because a console's normal state is
// half-written.

import { useState } from 'react'
import { useAdHocQuery } from '@flow-ts/react'
import type { Store } from '@flow-ts/react'

export interface QueryConsoleProps {
  store: Store
  initial: string
  hint: string
}

export function QueryConsole({ store, initial, hint }: QueryConsoleProps): JSX.Element {
  const [source, setSource] = useState(initial)
  const result = useAdHocQuery(store, source)
  const relations = [...result.rows.entries()].sort(([a], [b]) => a.localeCompare(b))

  return (
    <section className="console" data-testid="query-console">
      <h2>Query console</h2>
      <textarea
        className="program-editor"
        data-testid="console-source"
        value={source}
        onChange={(e) => setSource(e.target.value)}
        spellCheck={false}
        rows={Math.min(16, source.split('\n').length + 2)}
      />
      <p className="muted">{hint}</p>

      {result.error ? (
        <pre className="program-error" data-testid="console-error">
          {result.error}
        </pre>
      ) : relations.length === 0 ? (
        <p className="muted" data-testid="console-empty">
          (no rows — the query derived nothing, or derived only the relations it read)
        </p>
      ) : (
        <div className="console-results" data-testid="console-results">
          {relations.map(([relation, rows]) => (
            <div key={relation} className="console-result">
              <h3>
                {relation} <span className="muted">· {rows.length} row{rows.length === 1 ? '' : 's'}</span>
              </h3>
              <ul>
                {[...rows]
                  .map((row) => row.join(', '))
                  .sort()
                  .map((row) => (
                    <li key={row} data-testid={`console-row-${relation}-${row}`}>
                      {row}
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
