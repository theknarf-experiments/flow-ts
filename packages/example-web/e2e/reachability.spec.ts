// End-to-end test for the live reachability demo. Boots Vite, opens
// the page in headless Chromium, and exercises the live-query flow:
//
//   • seed state is rendered after the first microtask flush
//   • adding an edge to an already-reachable node propagates to Reach
//   • retracting an edge prunes the now-unreachable derivations
//   • changing the source rewires Reach without leftover state

import { expect, test } from '@playwright/test'

test.describe('reachability demo', () => {
  test('renders seeded graph state on load', async ({ page }) => {
    await page.goto('/')
    // Seed: nodes 1..7, source 1, edges 1→2, 2→3, 3→4, 2→5.
    // Reach: {1, 2, 3, 4, 5}.
    await expect(page.getByTestId('stat-nodes')).toHaveText('7')
    await expect(page.getByTestId('stat-edges')).toHaveText('4')
    await expect(page.getByTestId('stat-reachable')).toHaveText('5')
    await expect(page.getByTestId('current-source')).toHaveText('1')

    // Reachable list renders {1, 2, 3, 4, 5}.
    for (const id of [1, 2, 3, 4, 5]) {
      await expect(page.getByTestId(`reachable-${id}`)).toHaveText(String(id))
    }
    // 6 and 7 declared but not reachable from source 1.
    await expect(page.getByTestId('reachable-6')).toHaveCount(0)
    await expect(page.getByTestId('reachable-7')).toHaveCount(0)

    // Node panel marks reachable rows via a data attribute.
    await expect(page.getByTestId('node-3')).toHaveAttribute('data-reachable', 'true')
    await expect(page.getByTestId('node-6')).toHaveAttribute('data-reachable', 'false')
  })

  test('adding an edge into a reachable node extends Reach', async ({ page }) => {
    await page.goto('/')

    // The page has two `add` submit buttons (AddNode and AddEdge forms).
    // Submit via Enter on the second input to keep the path unambiguous.
    const addEdge = async (from: number, to: number) => {
      await page.getByTestId('edge-from-input').fill(String(from))
      await page.getByTestId('edge-to-input').fill(String(to))
      await page.getByTestId('edge-to-input').press('Enter')
    }

    // Bridge 4 → 6. 4 ∈ Reach, so 6 becomes reachable. 7 has no
    // incoming edge yet, so it stays out.
    await addEdge(4, 6)
    await expect(page.getByTestId('stat-edges')).toHaveText('5')
    await expect(page.getByTestId('stat-reachable')).toHaveText('6')
    await expect(page.getByTestId('reachable-6')).toBeVisible()
    await expect(page.getByTestId('reachable-7')).toHaveCount(0)

    // Now add 6→7: Reach should also pick up 7.
    await addEdge(6, 7)
    await expect(page.getByTestId('stat-reachable')).toHaveText('7')
    await expect(page.getByTestId('reachable-7')).toBeVisible()
  })

  test('retracting an edge prunes downstream Reach', async ({ page }) => {
    await page.goto('/')

    // Seed has 1→2. Removing it should retract 2, 3, 4, 5 from Reach,
    // leaving only {1} (the source itself, from `Reach(y) :- Source(y)`).
    await page.getByRole('button', { name: 'remove edge 1 to 2' }).click()

    await expect(page.getByTestId('stat-edges')).toHaveText('3')
    await expect(page.getByTestId('stat-reachable')).toHaveText('1')
    await expect(page.getByTestId('reachable-1')).toBeVisible()
    await expect(page.getByTestId('reachable-2')).toHaveCount(0)
    await expect(page.getByTestId('reachable-5')).toHaveCount(0)
  })

  test('changing the source rewires Reach', async ({ page }) => {
    await page.goto('/')

    // Switch source to 3. From 3, reachable = {3, 4} (nothing reaches 5
    // through 3).
    await page.getByTestId('source-input').fill('3')
    await page.getByTestId('set-source').click()

    await expect(page.getByTestId('current-source')).toHaveText('3')
    await expect(page.getByTestId('stat-reachable')).toHaveText('2')
    await expect(page.getByTestId('reachable-3')).toBeVisible()
    await expect(page.getByTestId('reachable-4')).toBeVisible()
    await expect(page.getByTestId('reachable-1')).toHaveCount(0)
    await expect(page.getByTestId('reachable-5')).toHaveCount(0)
  })

  test('clearing the source empties Reach entirely', async ({ page }) => {
    await page.goto('/')

    await page.getByTestId('clear-source').click()

    await expect(page.getByTestId('current-source')).toHaveText('(none)')
    await expect(page.getByTestId('stat-reachable')).toHaveText('0')
    await expect(page.getByTestId('reachable-empty')).toBeVisible()
  })

  test('adding a brand-new node leaves Reach untouched', async ({ page }) => {
    await page.goto('/')

    await page.getByTestId('add-node-input').fill('99')
    await page.getByTestId('add-node-input').press('Enter')

    await expect(page.getByTestId('stat-nodes')).toHaveText('8')
    // Reach unchanged: 99 has no incoming edges.
    await expect(page.getByTestId('stat-reachable')).toHaveText('5')
    await expect(page.getByTestId('node-99')).toBeVisible()
    await expect(page.getByTestId('node-99')).toHaveAttribute('data-reachable', 'false')
  })
})
