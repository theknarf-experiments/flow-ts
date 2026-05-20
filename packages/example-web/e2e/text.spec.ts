// End-to-end tests for the two-replica RGA text CRDT demo. Each
// replica owns its own Store; a SyncLink layered on top forwards new
// EDB rows between them after a configurable delay. Per-replica
// online toggles park ops locally until both sides come back online.

import { type Page, expect, test } from '@playwright/test'

async function gotoApp(page: Page): Promise<void> {
  await page.goto('/text')
  await expect(page.locator('body[data-hydrated="true"]')).toBeAttached()
}

test.describe('text CRDT demo — single replica (A)', () => {
  test('renders both editors zeroed on load', async ({ page }) => {
    await gotoApp(page)
    for (const id of ['a', 'b']) {
      await expect(page.getByTestId(`text-editor-${id}`)).toHaveValue('')
      await expect(page.getByTestId(`stat-inserts-${id}`)).toHaveText('0')
      await expect(page.getByTestId(`stat-visible-${id}`)).toHaveText('0')
    }
    await expect(page.getByTestId('sync-link-status')).toHaveText('connected')
  })

  test('typing in A inserts ops and renders the text', async ({ page }) => {
    await gotoApp(page)
    await page.getByTestId('text-editor-a').pressSequentially('hi!')
    await expect(page.getByTestId('text-editor-a')).toHaveValue('hi!')
    await expect(page.getByTestId('stat-inserts-a')).toHaveText('3')
    await expect(page.getByTestId('stat-visible-a')).toHaveText('3')
  })

  test('backspace tombstones the tail; log keeps growing', async ({ page }) => {
    await gotoApp(page)
    const editor = page.getByTestId('text-editor-a')
    await editor.pressSequentially('hello')
    await editor.press('Backspace')
    await editor.press('Backspace')

    await expect(editor).toHaveValue('hel')
    await expect(page.getByTestId('stat-inserts-a')).toHaveText('5')
    await expect(page.getByTestId('stat-removes-a')).toHaveText('2')
    await expect(page.getByTestId('stat-visible-a')).toHaveText('3')
  })

  test('inserting in the middle keeps the cursor at the insertion point', async ({ page }) => {
    await gotoApp(page)
    const editor = page.getByTestId('text-editor-a')
    await editor.pressSequentially('hello')
    await editor.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(2, 2))
    await editor.pressSequentially('XYZ')

    await expect(editor).toHaveValue('heXYZllo')
    const cursor = await editor.evaluate((el: HTMLTextAreaElement) => el.selectionStart)
    expect(cursor).toBe(5)
  })

  test('selecting a range and typing replaces it via Insert + Remove ops', async ({ page }) => {
    await gotoApp(page)
    const editor = page.getByTestId('text-editor-a')
    await editor.pressSequentially('hello world')
    await editor.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(6, 11))
    await editor.pressSequentially('there')

    await expect(editor).toHaveValue('hello there')
    await expect(page.getByTestId('stat-inserts-a')).toHaveText('16')
    await expect(page.getByTestId('stat-removes-a')).toHaveText('5')
    await expect(page.getByTestId('stat-visible-a')).toHaveText('11')
  })
})

test.describe('text CRDT demo — two-replica sync', () => {
  test('typing in A while both are online propagates to B', async ({ page }) => {
    await gotoApp(page)
    // Slam the delay sliders to 0 so the sync round-trip is bounded
    // by the next animation frame, not 250ms.
    for (const id of ['a', 'b']) {
      await page.getByTestId(`delay-${id}`).fill('0')
    }
    await page.getByTestId('text-editor-a').pressSequentially('hi')

    await expect(page.getByTestId('text-editor-a')).toHaveValue('hi')
    await expect(page.getByTestId('text-editor-b')).toHaveValue('hi')
    await expect(page.getByTestId('stat-visible-b')).toHaveText('2')
  })

  test('replicas diverge when one is offline, then converge on reconnect', async ({ page }) => {
    await gotoApp(page)
    for (const id of ['a', 'b']) {
      await page.getByTestId(`delay-${id}`).fill('0')
    }

    // Take B offline; type into A. The op queues at the link.
    await page.getByTestId('online-b').uncheck()
    await expect(page.getByTestId('sync-link-status')).toHaveText('partitioned')
    await page.getByTestId('text-editor-a').pressSequentially('hi')

    // A sees its own text; B still empty; one op queued for A → B.
    await expect(page.getByTestId('text-editor-a')).toHaveValue('hi')
    await expect(page.getByTestId('text-editor-b')).toHaveValue('')
    await expect(page.getByTestId('sync-queue-a-to-b')).toHaveText('2')

    // Bring B back online — the queue drains and both sides converge.
    await page.getByTestId('online-b').check()
    await expect(page.getByTestId('text-editor-b')).toHaveValue('hi')
    await expect(page.getByTestId('sync-queue-a-to-b')).toHaveText('0')
    await expect(page.getByTestId('sync-link-status')).toHaveText('connected')
  })

  test('concurrent edits from both replicas converge after reconnect', async ({ page }) => {
    await gotoApp(page)
    for (const id of ['a', 'b']) {
      await page.getByTestId(`delay-${id}`).fill('0')
    }

    // Partition the network and edit both sides independently.
    await page.getByTestId('online-a').uncheck()
    await page.getByTestId('online-b').uncheck()

    await page.getByTestId('text-editor-a').pressSequentially('AAA')
    await page.getByTestId('text-editor-b').pressSequentially('BBB')
    await expect(page.getByTestId('text-editor-a')).toHaveValue('AAA')
    await expect(page.getByTestId('text-editor-b')).toHaveValue('BBB')

    // Reconnect; the two sides converge to the same string.
    await page.getByTestId('online-a').check()
    await page.getByTestId('online-b').check()

    // Both editors should agree once queues drain. Each end has 6
    // inserts (3 local + 3 received) and 6 visible chars; the order
    // is whatever the CRDT picks based on replica id.
    await expect(page.getByTestId('stat-visible-a')).toHaveText('6')
    await expect(page.getByTestId('stat-visible-b')).toHaveText('6')
    const finalA = await page.getByTestId('text-editor-a').inputValue()
    const finalB = await page.getByTestId('text-editor-b').inputValue()
    expect(finalA).toBe(finalB)
    expect(finalA).toHaveLength(6)
    // The 6 chars are exactly the 3 from each replica.
    const sortedChars = finalA.split('').sort().join('')
    expect(sortedChars).toBe('AAABBB')
  })
})
