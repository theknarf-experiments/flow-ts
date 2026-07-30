/// <reference types="vite/client" />

// `vite/client` types `BASE_URL`, `MODE` and the rest; a site's own variables it
// cannot know about. Declared here so a typo in the name is a type error rather
// than `any`, which is the whole point of reading it through `src/site.ts`.
interface ImportMetaEnv {
  readonly VITE_SITE_NAME: string
}
