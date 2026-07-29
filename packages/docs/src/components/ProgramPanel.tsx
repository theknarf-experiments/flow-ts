// The live-editable Datalog source, shared by every page that has a program.
//
// "Rebuild" parses the textarea and, if it parses, swaps it into the running
// store. Existing EDB rows are captured and replayed against the new rules, so
// editing a rule doesn't cost you your data — which is the whole reason the
// tutorial can tell a reader to change a rule and look at what happens.
//
// Rule edits are not incremental in the IVM sense: the dataflow graph rebuilds
// from scratch. Fine for a page someone is reading, wrong for a hot path.

import { useEffect, useState } from 'react'
import { parseProgram } from '@flow-ts/parsing'
import type { Store } from '@flow-ts/react'

export interface ProgramPanelProps {
  store: Store
  /** The program as written. Also what "reset" restores. */
  source: string
  /** Collapsed by default on pages where the program isn't the point. */
  defaultOpen?: boolean
  /** Used as the parse error's filename, so messages name the page. */
  grammarSource?: string
}

export function ProgramPanel({
  store,
  source,
  defaultOpen = true,
  grammarSource = 'live.dl',
}: ProgramPanelProps): JSX.Element {
  const pristine = source.trim()
  const [draft, setDraft] = useState<string>(pristine)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'dirty' | 'rebuilt'>('idle')

  // Navigating between lessons swaps the store *and* the source under a
  // component React is free to reuse. Without this the second lesson would show
  // the first one's rules.
  useEffect(() => {
    setDraft(pristine)
    setError(null)
    setStatus('idle')
  }, [pristine, store])

  const onChange = (next: string) => {
    setDraft(next)
    setError(null)
    setStatus(next.trim() === pristine ? 'idle' : 'dirty')
  }

  const rebuild = () => {
    try {
      store.replaceProgram(parseProgram(draft, { grammarSource }))
      setError(null)
      setStatus('rebuilt')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('dirty')
    }
  }

  const reset = () => {
    setDraft(pristine)
    setError(null)
    try {
      store.replaceProgram(parseProgram(source, { grammarSource }))
      setStatus('rebuilt')
    } catch {
      // The bundled source is known-good — this branch is unreachable.
    }
  }

  return (
    <section className="program">
      <details open={defaultOpen} data-testid="program-panel">
        <summary>Datalog program</summary>
        <textarea
          className="program-editor"
          data-testid="program-source"
          value={draft}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          rows={Math.min(24, draft.split('\n').length + 1)}
        />
        <div className="program-actions">
          <button data-testid="program-rebuild" onClick={rebuild} disabled={status === 'idle'}>
            rebuild
          </button>
          <button data-testid="program-reset" onClick={reset} disabled={draft.trim() === pristine}>
            reset
          </button>
          <span className="program-status" data-testid="program-status">
            {error ? (
              <span className="program-error">{error}</span>
            ) : status === 'dirty' ? (
              <span className="muted">unsaved changes — click rebuild to apply</span>
            ) : status === 'rebuilt' ? (
              <span className="muted">program rebuilt · facts replayed</span>
            ) : (
              <span className="muted">edit the rules, then rebuild — your facts replay automatically.</span>
            )}
          </span>
        </div>
      </details>
    </section>
  )
}
