// The light / dark switch in the sidebar.
//
// Cycles system → light → dark → system. Three states rather than two because
// "follow my OS" is a real answer and dropping it would mean a reader who
// switches their machine to light at dusk has to come back here.
//
// State lives in the DOM (`<html data-theme-preference>`), written before first
// paint by `INIT_SCRIPT`. This component reads it on mount rather than
// initialising from it, because the prerendered HTML has no attribute yet and
// hydrating against a guess would mismatch.

import { useEffect, useState } from 'react'
import {
  applyPreference,
  readPreference,
  resolveTheme,
  type Theme,
  type ThemePreference,
} from '../theme.js'

const ORDER: readonly ThemePreference[] = ['system', 'light', 'dark']

const LABEL: Record<ThemePreference, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
}

const ICON: Record<ThemePreference, string> = {
  system: '◐',
  light: '☀',
  dark: '☾',
}

export function ThemeToggle(): JSX.Element {
  // Two pieces of state, and the split is what makes this page prerenderable.
  // The pages are rendered in Node, where there is no `matchMedia` and no
  // storage, so the first render has to be something the browser reproduces
  // *exactly* — otherwise React finds the server guessed dark where the
  // reader's machine says light, and throws the whole prerender away rather
  // than patch one attribute. So nothing here reads the environment during
  // render: the first pass is always `system` with the palette left unset, and
  // the effect fills both in a moment later.
  const [preference, setPreference] = useState<ThemePreference>('system')
  const [resolved, setResolved] = useState<Theme | null>(null)

  useEffect(() => {
    const stored = readPreference()
    setPreference(stored)
    setResolved(resolveTheme(stored))
  }, [])

  // While following the system, a change to the OS setting has to repaint. The
  // pinned states ignore it, hence the guard rather than an unconditional
  // listener.
  useEffect(() => {
    if (preference !== 'system' || typeof matchMedia === 'undefined') return
    const query = matchMedia('(prefers-color-scheme: light)')
    const onChange = () => applyPreference('system')
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [preference])

  const next = ORDER[(ORDER.indexOf(preference) + 1) % ORDER.length]!

  return (
    <button
      type="button"
      className="theme-toggle"
      data-testid="theme-toggle"
      data-preference={preference}
      // Absent until mounted, rather than guessed — see above.
      data-theme={resolved ?? undefined}
      title={`Theme: ${LABEL[preference]}${
        preference === 'system' && resolved ? ` (${resolved})` : ''
      } — click for ${LABEL[next].toLowerCase()}`}
      aria-label={`Theme: ${LABEL[preference]}. Switch to ${LABEL[next].toLowerCase()}.`}
      onClick={() => {
        applyPreference(next)
        setPreference(next)
        setResolved(resolveTheme(next))
      }}
    >
      <span className="theme-toggle-icon" aria-hidden="true">
        {ICON[preference]}
      </span>
      <span className="theme-toggle-label">{LABEL[preference]}</span>
    </button>
  )
}
