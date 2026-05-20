// End-to-end test for the live reachability demo. Boots Vite, opens
// the page in headless Chromium, and exercises the live-query flow:
//
//   • seed state is rendered after the first microtask flush
//   • adding an edge to an already-reachable node propagates to Reach
//   • retracting an edge prunes the now-unreachable derivations
//   • changing the source rewires Reach without leftover state

import { expect, test } from '@playwright/test'

test.describe('reachability demo', () => {
  test('renders the Datalog program source', async ({ page }) => {
    await page.goto('/')
    // The program panel shows the actual `.dl` source so readers can map
    // the live UI back onto the rules driving it.
    await expect(page.getByTestId('program-panel')).toBeVisible()
    const src = page.getByTestId('program-source')
    await expect(src).toContainText('.decl Reach(id: number)')
    await expect(src).toContainText('Reach(y) :- Source(y).')
    await expect(src).toContainText('Reach(z) :- Reach(y), Edge(y, z).')
  })

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
    // The "remove edge" button appears twice on the page (once in the
    // editor panel, once in the inspector's Edge table); both target
    // the same store row, so `.first()` is fine.
    await page.getByRole('button', { name: 'remove edge 1 to 2' }).first().click()

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

  test('relation inspector renders one table per declared relation', async ({ page }) => {
    await page.goto('/')
    for (const rel of ['Node', 'Source', 'Edge', 'Reach']) {
      await expect(page.getByTestId(`relation-table-${rel}`)).toBeVisible()
    }
    // Seed sizes match the bespoke panels.
    await expect(page.getByTestId('relation-count-Node')).toHaveText('7 rows')
    await expect(page.getByTestId('relation-count-Source')).toHaveText('1 row')
    await expect(page.getByTestId('relation-count-Edge')).toHaveText('4 rows')
    await expect(page.getByTestId('relation-count-Reach')).toHaveText('5 rows')
    await expect(page.getByTestId('relation-row-Reach-4')).toBeVisible()
  })

  test('inspector reacts to live edits', async ({ page }) => {
    await page.goto('/')
    // Adding 4 → 6 should grow both Edge and Reach by one row.
    await page.getByTestId('edge-from-input').fill('4')
    await page.getByTestId('edge-to-input').fill('6')
    await page.getByTestId('edge-to-input').press('Enter')

    await expect(page.getByTestId('relation-count-Edge')).toHaveText('5 rows')
    await expect(page.getByTestId('relation-count-Reach')).toHaveText('6 rows')
    await expect(page.getByTestId('relation-row-Reach-6')).toBeVisible()
  })

  test('EDB tables get an inline add-row; IDB tables do not', async ({ page }) => {
    await page.goto('/')
    // EDBs: Node, Source, Edge — all show an add-row.
    for (const rel of ['Node', 'Source', 'Edge']) {
      await expect(page.getByTestId(`add-row-${rel}`)).toBeVisible()
      await expect(page.getByTestId(`add-${rel}-submit`)).toBeVisible()
    }
    // IDB: Reach — derived, no add-row.
    await expect(page.getByTestId('add-row-Reach')).toHaveCount(0)
  })

  test('inserting a row via the add-row updates the live state', async ({ page }) => {
    await page.goto('/')

    // Use the Edge table's add-row to add 4 → 6 (same as the form
    // does, but via the generic component).
    await page.getByTestId('add-Edge-src').fill('4')
    await page.getByTestId('add-Edge-dst').fill('6')
    await page.getByTestId('add-Edge-submit').click()

    await expect(page.getByTestId('relation-count-Edge')).toHaveText('5 rows')
    await expect(page.getByTestId('relation-count-Reach')).toHaveText('6 rows')
    // Inputs clear after a successful insert.
    await expect(page.getByTestId('add-Edge-src')).toHaveValue('')
    await expect(page.getByTestId('add-Edge-dst')).toHaveValue('')
  })

  test('add-row also works via Enter and clears on success', async ({ page }) => {
    await page.goto('/')

    await page.getByTestId('add-Node-id').fill('100')
    await page.getByTestId('add-Node-id').press('Enter')

    await expect(page.getByTestId('relation-count-Node')).toHaveText('8 rows')
    await expect(page.getByTestId('add-Node-id')).toHaveValue('')
  })
})
