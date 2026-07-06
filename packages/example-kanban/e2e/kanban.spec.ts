// End-to-end tests for the kanban sync demo: native WebTransport
// (HTTP/3 + serverCertificateHashes) from real Chromium to the Node
// sync hub, with facts relayed between browser contexts through the
// server's MST.
//
// The hub keeps every fact for the lifetime of the process, so tests
// use unique card texts and never assert on total board counts.

import { type Page, expect, test } from '@playwright/test'

async function openBoard(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('sync-status')).toHaveText('✓ synced', {
    timeout: 15_000,
  })
}

async function addCard(page: Page, col: string, text: string): Promise<void> {
  const column = page.locator(`[data-col="${col}"]`)
  await column.getByPlaceholder('new card…').fill(text)
  await column.getByRole('button', { name: 'add' }).click()
}

function uniqueText(label: string): string {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

test('connects to the sync hub over WebTransport', async ({ page }) => {
  await openBoard(page)
})

test('a card added locally shows up on the board', async ({ page }) => {
  await openBoard(page)
  const text = uniqueText('local')
  await addCard(page, 'todo', text)
  await expect(page.locator('[data-col="todo"]').getByText(text)).toBeVisible()
})

test('a card added in one tab appears in another tab via the server', async ({
  browser,
}) => {
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()
  await openBoard(a)
  await openBoard(b)

  const text = uniqueText('sync')
  await addCard(a, 'todo', text)
  await expect(a.locator('[data-col="todo"]').getByText(text)).toBeVisible()
  // The fact travels a → server → b.
  await expect(b.locator('[data-col="todo"]').getByText(text)).toBeVisible({
    timeout: 10_000,
  })

  await ctxA.close()
  await ctxB.close()
})

test('deleting a card propagates to other tabs', async ({ browser }) => {
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()
  await openBoard(a)
  await openBoard(b)

  const text = uniqueText('delete')
  await addCard(a, 'todo', text)
  const cardOnB = b.locator('[data-col="todo"]').getByText(text)
  await expect(cardOnB).toBeVisible({ timeout: 10_000 })

  // Delete on B; the tombstone must hide the card on A too.
  await b
    .locator('[data-col="todo"] div', { hasText: text })
    .getByTitle('delete')
    .last()
    .click()
  await expect(cardOnB).toBeHidden()
  await expect(a.locator('[data-col="todo"]').getByText(text)).toBeHidden({
    timeout: 10_000,
  })

  await ctxA.close()
  await ctxB.close()
})

test('facts persist on the server across a page reload', async ({ page }) => {
  await openBoard(page)
  const text = uniqueText('persist')
  await addCard(page, 'doing', text)
  await expect(page.locator('[data-col="doing"]').getByText(text)).toBeVisible()

  // A fresh page load starts with an empty Store; the card must come
  // back from the server's MST during the initial sync.
  await page.reload()
  await expect(page.getByTestId('sync-status')).toHaveText('✓ synced', {
    timeout: 15_000,
  })
  await expect(page.locator('[data-col="doing"]').getByText(text)).toBeVisible({
    timeout: 10_000,
  })
})
