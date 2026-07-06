// End-to-end tests for the kanban sync demo: native WebTransport
// (HTTP/3 + serverCertificateHashes) from real Chromium to the Node
// sync hub, with facts relayed between browser contexts through the
// server's MST.
//
// The hub keeps every fact for the lifetime of the process, so tests
// use unique card/column/project names, never assert on totals, and
// never mutate the seeded default project or its todo/doing/done
// columns (a rename or tombstone on those would leak into every
// later test).

import { type Locator, type Page, expect, test } from '@playwright/test'

async function openBoard(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('sync-status')).toHaveText('✓ synced', {
    timeout: 15_000,
  })
}

function col(page: Page, name: string): Locator {
  return page.locator(`[data-col-name="${name}"]`)
}

async function addCard(page: Page, colName: string, text: string): Promise<void> {
  const column = col(page, colName)
  await column.getByPlaceholder('new card…').fill(text)
  await column.getByRole('button', { name: 'add' }).click()
}

async function addColumn(page: Page, name: string): Promise<void> {
  await page.getByTestId('new-column').fill(name)
  await page.getByTestId('add-column').click()
  await expect(col(page, name)).toBeVisible()
}

/** Create a project; the UI selects it automatically. */
async function addProject(page: Page, name: string): Promise<void> {
  await page.getByTestId('new-project').fill(name)
  await page.getByTestId('add-project').click()
  await expect(page.getByTestId('project-name')).toHaveText(name)
}

function projectOption(page: Page, name: string): Locator {
  return page.locator('[data-testid="project-select"] option', { hasText: name })
}

/** Wait for a project to arrive via sync, then switch to it. */
async function switchProject(page: Page, name: string): Promise<void> {
  await expect(projectOption(page, name)).toHaveCount(1, { timeout: 10_000 })
  await page.getByTestId('project-select').selectOption({ label: name })
  await expect(page.getByTestId('project-name')).toHaveText(name)
}

/** Left-to-right column names as rendered. */
function columnOrder(page: Page): Promise<(string | null)[]> {
  return page
    .locator('[data-col-name]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-col-name')))
}

function uniqueText(label: string): string {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

async function twoBoards(browser: import('@playwright/test').Browser) {
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()
  await openBoard(a)
  await openBoard(b)
  return { a, b, close: async () => Promise.all([ctxA.close(), ctxB.close()]) }
}

test('connects to the sync hub over WebTransport', async ({ page }) => {
  await openBoard(page)
  // The three seeded columns are on the board.
  for (const name of ['todo', 'doing', 'done']) {
    await expect(col(page, name)).toBeVisible()
  }
})

test('a card added locally shows up on the board', async ({ page }) => {
  await openBoard(page)
  const text = uniqueText('local')
  await addCard(page, 'todo', text)
  await expect(col(page, 'todo').getByText(text)).toBeVisible()
})

test('a card added in one tab appears in another tab via the server', async ({
  browser,
}) => {
  const { a, b, close } = await twoBoards(browser)

  const text = uniqueText('sync')
  await addCard(a, 'todo', text)
  await expect(col(a, 'todo').getByText(text)).toBeVisible()
  // The fact travels a → server → b.
  await expect(col(b, 'todo').getByText(text)).toBeVisible({ timeout: 10_000 })

  await close()
})

test('deleting a card propagates to other tabs', async ({ browser }) => {
  const { a, b, close } = await twoBoards(browser)

  const text = uniqueText('delete')
  await addCard(a, 'todo', text)
  const cardOnB = col(b, 'todo').getByText(text)
  await expect(cardOnB).toBeVisible({ timeout: 10_000 })

  // Delete on B; the tombstone must hide the card on A too.
  await col(b, 'todo')
    .locator('div', { hasText: text })
    .getByTitle('delete')
    .last()
    .click()
  await expect(cardOnB).toBeHidden()
  await expect(col(a, 'todo').getByText(text)).toBeHidden({ timeout: 10_000 })

  await close()
})

test('renaming a card propagates to other tabs', async ({ browser }) => {
  const { a, b, close } = await twoBoards(browser)

  const before = uniqueText('name')
  const after = uniqueText('renamed')
  await addCard(a, 'todo', before)
  await expect(col(b, 'todo').getByText(before)).toBeVisible({ timeout: 10_000 })

  // Double-click the card text on A, type the new name, commit.
  await col(a, 'todo').getByText(before).dblclick()
  await col(a, 'todo').getByTestId('card-rename').fill(after)
  await col(a, 'todo').getByTestId('card-rename').press('Enter')

  await expect(col(a, 'todo').getByText(after)).toBeVisible()
  await expect(col(b, 'todo').getByText(after)).toBeVisible({ timeout: 10_000 })
  // LWW: the old text is gone everywhere, not duplicated.
  await expect(col(a, 'todo').getByText(before)).toBeHidden()
  await expect(col(b, 'todo').getByText(before)).toBeHidden()

  await close()
})

test('adding and renaming a column propagates to other tabs', async ({
  browser,
}) => {
  const { a, b, close } = await twoBoards(browser)

  const before = uniqueText('col')
  const after = uniqueText('col-renamed')
  await addColumn(a, before)
  await expect(col(b, before)).toBeVisible({ timeout: 10_000 })

  await col(a, before).getByTestId('col-name').dblclick()
  await col(a, before).getByTestId('col-rename').fill(after)
  await col(a, before).getByTestId('col-rename').press('Enter')

  await expect(col(a, after)).toBeVisible()
  await expect(col(b, after)).toBeVisible({ timeout: 10_000 })
  await expect(col(a, before)).toHaveCount(0)
  await expect(col(b, before)).toHaveCount(0)

  await close()
})

test('reordering columns propagates to other tabs', async ({ browser }) => {
  const { a, b, close } = await twoBoards(browser)

  const left = uniqueText('left')
  const right = uniqueText('right')
  await addColumn(a, left)
  await addColumn(a, right) // appended after `left`
  await expect(col(b, right)).toBeVisible({ timeout: 10_000 })

  let order = await columnOrder(a)
  expect(order.indexOf(left)).toBeLessThan(order.indexOf(right))

  // Swap: move `right` one step left.
  await col(a, right).getByTestId('col-left').click()

  await expect
    .poll(async () => {
      const names = await columnOrder(a)
      return names.indexOf(right) < names.indexOf(left)
    })
    .toBe(true)
  await expect
    .poll(
      async () => {
        const names = await columnOrder(b)
        return names.indexOf(right) < names.indexOf(left)
      },
      { timeout: 10_000 },
    )
    .toBe(true)

  await close()
})

test('deleting a column hides it and its cards in every tab', async ({
  browser,
}) => {
  const { a, b, close } = await twoBoards(browser)

  const name = uniqueText('doomed')
  const cardText = uniqueText('orphan')
  await addColumn(a, name)
  await addCard(a, name, cardText)
  await expect(col(b, name).getByText(cardText)).toBeVisible({ timeout: 10_000 })

  await col(a, name).getByTestId('col-delete').click()

  await expect(col(a, name)).toHaveCount(0)
  await expect(col(b, name)).toHaveCount(0, { timeout: 10_000 })
  // The card lived in the deleted column — hidden with it.
  await expect(a.getByText(cardText)).toBeHidden()
  await expect(b.getByText(cardText)).toBeHidden()

  await close()
})

test('a new project propagates, and its board is scoped to it', async ({
  browser,
}) => {
  const { a, b, close } = await twoBoards(browser)

  const project = uniqueText('proj')
  const column = uniqueText('proj-col')
  const card = uniqueText('proj-card')

  // Creating a project switches A to it and seeds default columns.
  await addProject(a, project)
  await expect(col(a, 'todo')).toBeVisible()
  await addColumn(a, column)
  await addCard(a, 'todo', card)

  // B is still on the default project: nothing from `project` shows.
  await expect(projectOption(b, project)).toHaveCount(1, { timeout: 10_000 })
  await expect(col(b, column)).toHaveCount(0)
  await expect(b.getByText(card)).toHaveCount(0)

  // Switching B to the project reveals its columns and cards.
  await switchProject(b, project)
  await expect(col(b, column)).toBeVisible({ timeout: 10_000 })
  await expect(col(b, 'todo').getByText(card)).toBeVisible({ timeout: 10_000 })

  // And back to default hides them again.
  await switchProject(b, 'default')
  await expect(col(b, column)).toHaveCount(0)
  await expect(b.getByText(card)).toHaveCount(0)

  await close()
})

test('renaming a project propagates to other tabs', async ({ browser }) => {
  const { a, b, close } = await twoBoards(browser)

  const before = uniqueText('proj')
  const after = uniqueText('proj-renamed')
  await addProject(a, before)
  await expect(projectOption(b, before)).toHaveCount(1, { timeout: 10_000 })

  await a.getByTestId('project-name').dblclick()
  await a.getByTestId('project-rename').fill(after)
  await a.getByTestId('project-rename').press('Enter')

  await expect(a.getByTestId('project-name')).toHaveText(after)
  // LWW: the option is renamed everywhere, not duplicated.
  await expect(projectOption(b, after)).toHaveCount(1, { timeout: 10_000 })
  await expect(projectOption(b, before)).toHaveCount(0)
  await expect(projectOption(a, before)).toHaveCount(0)

  await close()
})

test('facts persist on the server across a page reload', async ({ page }) => {
  await openBoard(page)
  const text = uniqueText('persist')
  await addCard(page, 'doing', text)
  await expect(col(page, 'doing').getByText(text)).toBeVisible()

  // A fresh page load starts with an empty Store; the card must come
  // back from the server's MST during the initial sync.
  await page.reload()
  await expect(page.getByTestId('sync-status')).toHaveText('✓ synced', {
    timeout: 15_000,
  })
  await expect(col(page, 'doing').getByText(text)).toBeVisible({
    timeout: 10_000,
  })
})
