// Light / dark mode, stored as an attribute on `<html>`.
//
// Three states, not two: "system" follows `prefers-color-scheme` and is the
// default, so a reader who has never touched the toggle gets whatever their OS
// says. Picking light or dark pins it and writes the choice to localStorage.
//
// The attribute — rather than a React context — is what the CSS reads, so a
// theme change repaints without re-rendering the tree. `INIT_SCRIPT` below
// applies the stored choice in `<head>`, before first paint, which is the only
// way to avoid a flash of the wrong palette on load.

export type Theme = 'light' | 'dark'
export type ThemePreference = Theme | 'system'

export const STORAGE_KEY = 'flow-ts-theme'

/** The stored preference, or `system` when there isn't one (or when we're
 *  running somewhere without a DOM, as the prerender is). */
export function readPreference(): ThemePreference {
  if (typeof localStorage === 'undefined') return 'system'
  const raw = localStorage.getItem(STORAGE_KEY)
  return raw === 'light' || raw === 'dark' ? raw : 'system'
}

/** What `system` currently resolves to. */
export function systemTheme(): Theme {
  if (typeof matchMedia === 'undefined') return 'dark'
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function resolveTheme(preference: ThemePreference): Theme {
  return preference === 'system' ? systemTheme() : preference
}

/** Write the preference to the DOM and to storage. `system` clears the stored
 *  key rather than storing the word, so a reader who resets keeps following
 *  their OS even if they later change it. */
export function applyPreference(preference: ThemePreference): void {
  const root = document.documentElement
  root.dataset.theme = resolveTheme(preference)
  // `color-scheme` is what makes form controls, scrollbars and the like follow
  // along; CSS custom properties can't reach those.
  root.style.colorScheme = resolveTheme(preference)
  root.dataset.themePreference = preference
  if (preference === 'system') localStorage.removeItem(STORAGE_KEY)
  else localStorage.setItem(STORAGE_KEY, preference)
}

/**
 * Runs in `<head>` before the first paint. Deliberately terse and dependency-
 * free — it is inlined as a string, so nothing here can be imported.
 *
 * Kept in sync with `applyPreference` by hand. If they disagree the only
 * symptom is a one-frame flash, which is what this exists to prevent.
 */
export const INIT_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem('${STORAGE_KEY}');
    var pref = stored === 'light' || stored === 'dark' ? stored : 'system';
    var theme = pref === 'system'
      ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : pref;
    var root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.themePreference = pref;
    root.style.colorScheme = theme;
  } catch (e) {
    /* private mode, blocked storage — fall through to the CSS default */
  }
})();
`.trim()
