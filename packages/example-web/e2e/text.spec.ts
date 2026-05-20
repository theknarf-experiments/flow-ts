// End-to-end test for the `/text` route — Stewen's list CRDT driving
// a textarea. Each keystroke turns into an `Insert` op; backspace
// emits a `Remove`. The visible text comes from walking the derived
// `ListElem` linked list.

import { type Page, expect, test } from '@playwright/test'

async function gotoApp(page: Page): Promise<void> {
  await page.goto('/text')
  await expect(page.locator('body[data-hydrated="true"]')).toBeAttached()
}

test.describe('text CRDT demo', () => {
  test('renders the editor and zeroed stats on load', async ({ page }) => {
    await gotoApp(page)
    await expect(page.getByTestId('text-editor')).toBeVisible()
    await expect(page.getByTestId('text-editor')).toHaveValue('')
    await expect(page.getByTestId('stat-inserts')).toHaveText('0')
    await expect(page.getByTestId('stat-removes')).toHaveText('0')
    await expect(page.getByTestId('stat-visible')).toHaveText('0')
  })

  test('typing characters appends Insert ops and renders the text', async ({ page }) => {
    await gotoApp(page)
    const editor = page.getByTestId('text-editor')

    // Playwright's `pressSequentially` fires one keystroke per char,
    // exactly what the CRDT-driven onChange expects.
    await editor.pressSequentially('hi!')

    await expect(editor).toHaveValue('hi!')
    await expect(page.getByTestId('stat-inserts')).toHaveText('3')
    await expect(page.getByTestId('stat-removes')).toHaveText('0')
    await expect(page.getByTestId('stat-visible')).toHaveText('3')
    // ListElem grew to three rows — one per visible character.
    await expect(page.getByTestId('relation-count-ListElem')).toHaveText('3 rows')
    // Insert EDB shows the underlying ops.
    await expect(page.getByTestId('relation-count-Insert')).toHaveText('3 rows')
  })

  test('backspace emits Remove ops; tombstones live alongside inserts', async ({ page }) => {
    await gotoApp(page)
    const editor = page.getByTestId('text-editor')
    await editor.pressSequentially('hello')
    await expect(page.getByTestId('stat-visible')).toHaveText('5')

    // Two backspaces should leave "hel" visible but keep both inserts
    // AND two tombstones in the EDBs (the CRDT log is append-only).
    await editor.press('Backspace')
    await editor.press('Backspace')

    await expect(editor).toHaveValue('hel')
    await expect(page.getByTestId('stat-inserts')).toHaveText('5')
    await expect(page.getByTestId('stat-removes')).toHaveText('2')
    await expect(page.getByTestId('stat-visible')).toHaveText('3')
  })

  test('retyping after backspace appends fresh Insert ops (no resurrection)', async ({ page }) => {
    await gotoApp(page)
    const editor = page.getByTestId('text-editor')
    await editor.pressSequentially('hi')
    await editor.press('Backspace')
    await editor.pressSequentially('a')

    // 3 inserts (h, i, a), 1 remove (i), 2 visible (h, a).
    await expect(editor).toHaveValue('ha')
    await expect(page.getByTestId('stat-inserts')).toHaveText('3')
    await expect(page.getByTestId('stat-removes')).toHaveText('1')
    await expect(page.getByTestId('stat-visible')).toHaveText('2')
  })

  test('inspector shows the EDB rows are addressable', async ({ page }) => {
    await gotoApp(page)
    await page.getByTestId('text-editor').pressSequentially('ab')

    // Each insert lives under `relation-row-Insert-<rep>-<ctr>-<parent_rep>-<parent_ctr>-<value>`.
    // The first char has parent (0, 0); the second char's parent is
    // the first char's (rep, ctr) = (1, 1).
    await expect(page.getByTestId('relation-row-Insert-1-1-0-0-a')).toBeVisible()
    await expect(page.getByTestId('relation-row-Insert-1-2-1-1-b')).toBeVisible()
  })

  test('inserting in the middle of the text adds chars at the cursor', async ({ page }) => {
    await gotoApp(page)
    const editor = page.getByTestId('text-editor')
    await editor.pressSequentially('hello')
    // Cursor between 'e' and 'l' (position 2). Type a character that's
    // unique to the string so the prefix/suffix diff is unambiguous.
    await editor.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(2, 2))
    await editor.pressSequentially('X')

    await expect(editor).toHaveValue('heXllo')
    await expect(page.getByTestId('stat-inserts')).toHaveText('6')
    await expect(page.getByTestId('stat-removes')).toHaveText('0')
    // The new insert (ctr 6) has the 'e' (ctr 2) as its parent — i.e.
    // it points at the character it was inserted *after*.
    await expect(page.getByTestId('relation-row-Insert-1-6-1-2-X')).toBeVisible()
  })

  test('deleting in the middle tombstones the right character', async ({ page }) => {
    await gotoApp(page)
    const editor = page.getByTestId('text-editor')
    await editor.pressSequentially('hello')
    // Move into the middle and backspace the second 'l' (position 3).
    await editor.press('ArrowLeft') // cursor before 'o'
    await editor.press('Backspace') // deletes 'l' at position 3

    await expect(editor).toHaveValue('helo')
    await expect(page.getByTestId('stat-inserts')).toHaveText('5')
    await expect(page.getByTestId('stat-removes')).toHaveText('1')
    await expect(page.getByTestId('stat-visible')).toHaveText('4')
    // The tombstone targets ctr 4 (the second 'l') — not ctr 5 ('o').
    await expect(page.getByTestId('relation-row-Remove-1-4')).toBeVisible()
  })

  test('selecting a range and typing replaces the selection in one go', async ({ page }) => {
    await gotoApp(page)
    const editor = page.getByTestId('text-editor')
    await editor.pressSequentially('hello world')
    // Select 'world' (positions 6..11) and replace with 'there'.
    await editor.evaluate((el: HTMLTextAreaElement) => {
      el.setSelectionRange(6, 11)
    })
    await editor.pressSequentially('there')

    await expect(editor).toHaveValue('hello there')
    // 11 original + 5 new inserts (the chars in 'there') = 16 inserts;
    // 5 tombstones for the original 'world'.
    await expect(page.getByTestId('stat-inserts')).toHaveText('16')
    await expect(page.getByTestId('stat-removes')).toHaveText('5')
    await expect(page.getByTestId('stat-visible')).toHaveText('11')
  })
})
