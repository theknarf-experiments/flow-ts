// End-to-end tests for the two-replica MVR key-value store demo. Both
// replicas run the same program (no-CB variant by default); editing
// concurrently with a partition then reconnecting should surface both
// values on the same key on both sides.

import { type Page, expect, test } from '@playwright/test'

async function gotoApp(page: Page): Promise<void> {
  await page.goto('/mvr')
  await expect(page.locator('body[data-hydrated="true"]')).toBeAttached()
  // Zero out the network delay so test waits stay bounded.
  for (const id of ['a', 'b']) {
    await page.getByTestId(`delay-${id}`).fill('0')
  }
}

async function writeKey(
  page: Page,
  replicaId: 'a' | 'b',
  key: string,
  value: string,
): Promise<void> {
  await page.getByTestId(`mvr-new-key-${replicaId}`).fill(key)
  await page.getByTestId(`mvr-new-value-${replicaId}`).fill(value)
  await page.getByTestId(`mvr-add-submit-${replicaId}`).click()
}

async function overwriteKey(
  page: Page,
  replicaId: 'a' | 'b',
  key: string,
  value: string,
): Promise<void> {
  await page.getByTestId(`mvr-write-${replicaId}-${key}`).fill(value)
  await page.getByTestId(`mvr-write-${replicaId}-${key}`).press('Enter')
}

test.describe('MVR key-value store demo', () => {
  test('renders both replicas zeroed on load', async ({ page }) => {
    await gotoApp(page)
    for (const id of ['a', 'b']) {
      await expect(page.getByTestId(`stat-sets-${id}`)).toHaveText('0')
      await expect(page.getByTestId(`stat-preds-${id}`)).toHaveText('0')
      await expect(page.getByTestId(`stat-mvr-${id}`)).toHaveText('0')
    }
    await expect(page.getByTestId('sync-link-status')).toHaveText('connected')
  })

  test('writing a key in A propagates to B while both are online', async ({ page }) => {
    await gotoApp(page)
    await writeKey(page, 'a', 'color', 'red')

    await expect(page.getByTestId('mvr-value-a-color')).toHaveText('red')
    await expect(page.getByTestId('mvr-value-b-color')).toHaveText('red')
    await expect(page.getByTestId('stat-mvr-a')).toHaveText('1')
    await expect(page.getByTestId('stat-mvr-b')).toHaveText('1')
  })

  test('overwriting a key once retains a single value, no conflict', async ({ page }) => {
    await gotoApp(page)
    await writeKey(page, 'a', 'color', 'red')
    await expect(page.getByTestId('mvr-value-b-color')).toHaveText('red')

    // Replica B overwrites the same key — sees the earlier write,
    // points a Pred edge at it, so MvrStore drops to one row.
    await overwriteKey(page, 'b', 'color', 'blue')

    await expect(page.getByTestId('mvr-value-a-color')).toHaveText('blue')
    await expect(page.getByTestId('mvr-value-b-color')).toHaveText('blue')
    await expect(page.getByTestId('stat-mvr-a')).toHaveText('1')
  })

  test('concurrent writes to the same key surface BOTH values on both sides', async ({ page }) => {
    await gotoApp(page)
    // Seed a value first so both replicas know about the key.
    await writeKey(page, 'a', 'color', 'green')
    await expect(page.getByTestId('mvr-value-b-color')).toHaveText('green')

    // Partition the network, then write conflicting values.
    await page.getByTestId('online-a').uncheck()
    await page.getByTestId('online-b').uncheck()
    await overwriteKey(page, 'a', 'color', 'red')
    await overwriteKey(page, 'b', 'color', 'blue')
    await expect(page.getByTestId('mvr-value-a-color')).toHaveText('red')
    await expect(page.getByTestId('mvr-value-b-color')).toHaveText('blue')

    // Reconnect. Both replicas should now see both values for `color`.
    await page.getByTestId('online-a').check()
    await page.getByTestId('online-b').check()

    await expect(page.getByTestId('mvr-value-a-color')).toHaveText('blue, red')
    await expect(page.getByTestId('mvr-value-b-color')).toHaveText('blue, red')
    await expect(page.getByTestId('stat-mvr-a')).toHaveText('2')
    await expect(page.getByTestId('stat-mvr-b')).toHaveText('2')
  })

  test('resolving a conflict by writing once collapses both branches', async ({ page }) => {
    await gotoApp(page)
    await writeKey(page, 'a', 'color', 'green')

    // Force a conflict.
    await page.getByTestId('online-a').uncheck()
    await page.getByTestId('online-b').uncheck()
    await overwriteKey(page, 'a', 'color', 'red')
    await overwriteKey(page, 'b', 'color', 'blue')
    await page.getByTestId('online-a').check()
    await page.getByTestId('online-b').check()
    await expect(page.getByTestId('mvr-value-a-color')).toHaveText('blue, red')

    // One more write while both online — Pred edges go to both
    // current leaves, collapsing the conflict.
    await overwriteKey(page, 'a', 'color', 'purple')

    await expect(page.getByTestId('mvr-value-a-color')).toHaveText('purple')
    await expect(page.getByTestId('mvr-value-b-color')).toHaveText('purple')
    await expect(page.getByTestId('stat-mvr-a')).toHaveText('1')
  })

  test('switching to the causal-broadcast variant rebuilds derivations from the same EDB log', async ({ page }) => {
    await gotoApp(page)
    await writeKey(page, 'a', 'color', 'red')
    await writeKey(page, 'a', 'shape', 'square')
    const setsBefore = await page.getByTestId('stat-sets-a').textContent()
    const predsBefore = await page.getByTestId('stat-preds-a').textContent()

    await page.getByTestId('variant-with-cb').check()

    // EDB log is intact across the program swap; derivations rebuild.
    await expect(page.getByTestId('stat-sets-a')).toHaveText(setsBefore!)
    await expect(page.getByTestId('stat-preds-a')).toHaveText(predsBefore!)
    await expect(page.getByTestId('mvr-value-a-color')).toHaveText('red')
    await expect(page.getByTestId('mvr-value-a-shape')).toHaveText('square')
    // CB variant exposes an IsCausallyReady IDB the no-CB variant doesn't.
    await expect(page.getByTestId('relation-table-IsCausallyReady')).toBeVisible()
  })
})
