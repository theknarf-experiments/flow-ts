// What the site calls the thing it documents, for the components that display it.
//
// The value and its default live in `vite.config.ts`, which `define`s this
// expression at build time. No fallback here on purpose: a second default is a
// second place to change, and a missing `define` should fail visibly rather than
// resolve to a stale name.

export const SITE_NAME: string = import.meta.env.VITE_SITE_NAME
