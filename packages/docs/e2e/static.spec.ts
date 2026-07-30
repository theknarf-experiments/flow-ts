// What the static build is for.
//
// The rest of the suite drives the app with JavaScript on, which passes just as
// well against a plain SPA — it cannot tell whether the markup was prerendered
// or rendered on arrival. These tests are the difference: the pages exist as
// files, and their content is in the HTML before anything runs.

import { expect, test } from '@playwright/test'

test.describe('prerendered pages', () => {
  test('a lesson is complete HTML with scripting off entirely', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false })
    const page = await context.newPage()
    await page.goto('/learn/recursion/')

    // The prose and the sidebar, but also the *derived* tables: the engine ran
    // at build time, so the answers are in the file.
    await expect(page.getByRole('heading', { name: 'Recursion' })).toBeVisible()
    await expect(page.getByTestId('sidenav-lessons').locator('a')).toHaveCount(14)
    await expect(page.getByTestId('relation-table-Ancestor')).toBeVisible()
    await expect(page.getByTestId('relation-count-Ancestor')).toHaveText('9 rows')
    await context.close()
  })

  // Deep-linked *without* a trailing slash, which is the form every link on the
  // site generates. This is the test that was missing: written with trailing
  // slashes it passed while `preview` was serving the overview page for every
  // one of these, because the extensionless path matched no file and fell
  // through to the SPA fallback. The client then rendered the right page over
  // the wrong markup, which looked exactly like a hydration bug in the app.
  test('a deep link serves its own page, with no trailing slash', async ({ request }) => {
    const expected: Array<[string, string]> = [
      ['/', 'flow-ts'],
      ['/learn/facts', 'Facts and rules'],
      ['/learn/put-into', 'Joins and refusals: .put into, .put none'],
      ['/friends', 'flow-ts • friend-graph demo'],
      ['/vault', 'Markdown vault'],
      ['/vault/shapes', 'Markdown vault'],
    ]
    for (const [path, heading] of expected) {
      const response = await request.get(path)
      expect(response.status(), path).toBe(200)
      // The heading is in the HTML, so this checks *which* page was served —
      // a 200 alone would have been satisfied by the fallback.
      expect(await response.text(), path).toContain(`<h1>${heading}</h1>`)
    }
  })

  test('and with one, which is what GitHub Pages redirects to', async ({ request }) => {
    for (const path of ['/learn/facts/', '/friends/', '/vault/shapes/']) {
      const response = await request.get(path)
      expect(response.status(), path).toBe(200)
    }
  })

  test('there is a 404 page, which is what Pages serves for a bad path', async ({ request }) => {
    const response = await request.get('/404.html')
    expect(response.status()).toBe(200)
    expect(await response.text()).toContain('Not found')
  })

  test('the sidebar marks the current page, in the HTML', async ({ request }) => {
    // Rendered with the router's own matching rather than patched in after, so
    // a reader with a slow connection still sees where they are.
    const html = await (await request.get('/learn/joins/')).text()
    expect(html).toContain('aria-current="page"')
    expect(html).toMatch(/aria-current="page"[^>]*href="\/learn\/joins"/)
  })
})

// Hydration, which is the point of prerendering: React has to *adopt* the markup
// rather than discard it and render again. It does that silently when it works
// and complains when it doesn't, so the assertion is simply that nothing was
// logged. Without it, a mismatch costs only performance — the page still ends up
// correct — which is precisely why it went unnoticed.
test.describe('hydration', () => {
  const PAGES = ['/', '/learn/facts', '/learn/put-spread', '/friends', '/text', '/mvr', '/vault', '/vault/shapes']

  for (const path of PAGES) {
    test(`adopts the prerendered markup at ${path}`, async ({ page }) => {
      const complaints: string[] = []
      page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning') {
          complaints.push(`${message.type()}: ${message.text().split('\n')[0]}`)
        }
      })
      page.on('pageerror', (error) => complaints.push(`threw: ${error.message.split('\n')[0]}`))

      await page.goto(path)
      await page.waitForSelector('body[data-hydrated="true"]')
      // Long enough for the effects that follow hydration to settle.
      await page.waitForTimeout(300)

      expect(complaints, `${path} logged during hydration`).toEqual([])
    })
  }
})
