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

  test('every route is a file, so a deep link needs no server', async ({ request }) => {
    for (const path of ['/', '/learn/facts/', '/learn/put-into/', '/friends/', '/vault/shapes/']) {
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
