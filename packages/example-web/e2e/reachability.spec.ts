// End-to-end test for the friend-graph demo. Boots Vite, opens the
// page in headless Chromium, and exercises the live-query flow:
//
//   • seed state is rendered after the first microtask flush
//   • adding a friendship into the reachable component extends ICanReach
//   • retracting a friendship prunes the now-unreachable derivations
//   • changing the Me row rewires ICanReach without leftover state
//
// All edits go through the generic RelationInspector at the bottom of
// the page — there is no bespoke editor form.

import { expect, test } from '@playwright/test'

test.describe('friend-graph demo', () => {
  test('renders the Datalog program source in an editable textarea', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('program-panel')).toBeVisible()
    const src = page.getByTestId('program-source')
    const value = await src.inputValue()
    expect(value).toContain('.decl Person(id: number, name: string)')
    expect(value).toContain('Reach(x, y) :- Friend(x, y).')
    expect(value).toContain(
      'ICanReach(name) :- Me(me), Reach(me, id), Person(id, name).',
    )
  })

  test('renders seeded state on load', async ({ page }) => {
    await page.goto('/')
    // Seed: 6 people, friendships 1→2, 2→3, 3→4, 1→5; Me = {1 alice}.
    // ICanReach from alice: {bob, carol, dave, eve}.
    await expect(page.getByTestId('stat-me')).toHaveText('alice')
    await expect(page.getByTestId('stat-people')).toHaveText('6')
    await expect(page.getByTestId('stat-friends')).toHaveText('4')
    await expect(page.getByTestId('stat-reachable')).toHaveText('4')

    for (const name of ['bob', 'carol', 'dave', 'eve']) {
      await expect(page.getByTestId(`reachable-${name}`)).toHaveText(name)
    }
    // alice (=me) doesn't appear in ICanReach; frank has no incoming edge.
    await expect(page.getByTestId('reachable-alice')).toHaveCount(0)
    await expect(page.getByTestId('reachable-frank')).toHaveCount(0)

    // People panel marks reachable rows via a data attribute and surfaces
    // the name on the row.
    await expect(page.getByTestId('person-3')).toHaveAttribute('data-reachable', 'true')
    await expect(page.getByTestId('person-3')).toHaveAttribute('data-name', 'carol')
    await expect(page.getByTestId('person-6')).toHaveAttribute('data-reachable', 'false')
  })

  test('adding a friendship into the reachable component extends ICanReach', async ({ page }) => {
    await page.goto('/')

    const addFriend = async (a: number, b: number) => {
      await page.getByTestId('add-Friend-a').fill(String(a))
      await page.getByTestId('add-Friend-b').fill(String(b))
      await page.getByTestId('add-Friend-b').press('Enter')
    }

    // 4 dave is reachable from alice. Bridge dave → frank so frank shows up.
    await addFriend(4, 6)
    await expect(page.getByTestId('stat-friends')).toHaveText('5')
    await expect(page.getByTestId('stat-reachable')).toHaveText('5')
    await expect(page.getByTestId('reachable-frank')).toBeVisible()
  })

  test('retracting a friendship prunes downstream ICanReach', async ({ page }) => {
    await page.goto('/')

    // Removing 1 alice → 2 bob retracts bob, carol, and dave, leaving only
    // eve (still directly friended by alice via 1 → 5).
    await page.getByRole('button', { name: 'remove Friend 1 2' }).click()

    await expect(page.getByTestId('stat-friends')).toHaveText('3')
    await expect(page.getByTestId('stat-reachable')).toHaveText('1')
    await expect(page.getByTestId('reachable-eve')).toBeVisible()
    await expect(page.getByTestId('reachable-bob')).toHaveCount(0)
    await expect(page.getByTestId('reachable-carol')).toHaveCount(0)
    await expect(page.getByTestId('reachable-dave')).toHaveCount(0)
  })

  test('changing Me rewires ICanReach', async ({ page }) => {
    await page.goto('/')

    // Drop Me=1 and add Me=2. From bob, reachable = {carol, dave}.
    await page.getByRole('button', { name: 'remove Me 1' }).click()
    await page.getByTestId('add-Me-id').fill('2')
    await page.getByTestId('add-Me-id').press('Enter')

    await expect(page.getByTestId('stat-me')).toHaveText('bob')
    await expect(page.getByTestId('stat-reachable')).toHaveText('2')
    await expect(page.getByTestId('reachable-carol')).toBeVisible()
    await expect(page.getByTestId('reachable-dave')).toBeVisible()
    await expect(page.getByTestId('reachable-bob')).toHaveCount(0)
    await expect(page.getByTestId('reachable-alice')).toHaveCount(0)
    await expect(page.getByTestId('reachable-eve')).toHaveCount(0)
  })

  test('clearing Me empties ICanReach entirely', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'remove Me 1' }).click()

    await expect(page.getByTestId('stat-me')).toHaveText('(none)')
    await expect(page.getByTestId('stat-reachable')).toHaveText('0')
    await expect(page.getByTestId('reachable-empty')).toBeVisible()
  })

  test('adding a brand-new person leaves ICanReach untouched', async ({ page }) => {
    await page.goto('/')

    await page.getByTestId('add-Person-id').fill('99')
    await page.getByTestId('add-Person-name').fill('grace')
    await page.getByTestId('add-Person-name').press('Enter')

    await expect(page.getByTestId('stat-people')).toHaveText('7')
    // Grace has no incoming friendship — reachable set is unchanged.
    await expect(page.getByTestId('stat-reachable')).toHaveText('4')
    await expect(page.getByTestId('person-99')).toBeVisible()
    await expect(page.getByTestId('person-99')).toHaveAttribute('data-name', 'grace')
    await expect(page.getByTestId('person-99')).toHaveAttribute('data-reachable', 'false')
  })

  test('relation inspector renders one table per declared relation', async ({ page }) => {
    await page.goto('/')
    for (const rel of [
      'Person',
      'Me',
      'Friend',
      'Weight',
      'Reach',
      'ICanReach',
      'ReachableWeight',
    ]) {
      await expect(page.getByTestId(`relation-table-${rel}`)).toBeVisible()
    }
    await expect(page.getByTestId('relation-count-Person')).toHaveText('6 rows')
    await expect(page.getByTestId('relation-count-Me')).toHaveText('1 row')
    await expect(page.getByTestId('relation-count-Friend')).toHaveText('4 rows')
    await expect(page.getByTestId('relation-count-Weight')).toHaveText('6 rows')
    await expect(page.getByTestId('relation-count-ICanReach')).toHaveText('4 rows')
    await expect(page.getByTestId('relation-count-ReachableWeight')).toHaveText('4 rows')
  })

  test('inspector reacts to live edits and surfaces derived strings', async ({ page }) => {
    await page.goto('/')
    // Add a fresh person + friendship that should land them in ICanReach.
    await page.getByTestId('add-Person-id').fill('99')
    await page.getByTestId('add-Person-name').fill('grace')
    await page.getByTestId('add-Person-name').press('Enter')

    await page.getByTestId('add-Friend-a').fill('4')
    await page.getByTestId('add-Friend-b').fill('99')
    await page.getByTestId('add-Friend-b').press('Enter')

    await expect(page.getByTestId('relation-count-Person')).toHaveText('7 rows')
    await expect(page.getByTestId('relation-count-Friend')).toHaveText('5 rows')
    await expect(page.getByTestId('relation-count-ICanReach')).toHaveText('5 rows')
    // The new name shows up as an ICanReach row in the inspector.
    await expect(page.getByTestId('relation-row-ICanReach-grace')).toBeVisible()
  })

  test('EDB tables get an inline add-row; IDB tables do not', async ({ page }) => {
    await page.goto('/')
    for (const rel of ['Person', 'Me', 'Friend', 'Weight']) {
      await expect(page.getByTestId(`add-row-${rel}`)).toBeVisible()
      await expect(page.getByTestId(`add-${rel}-submit`)).toBeVisible()
    }
    for (const rel of ['Reach', 'ICanReach', 'ReachableWeight']) {
      await expect(page.getByTestId(`add-row-${rel}`)).toHaveCount(0)
    }
  })

  test('Person add-row mixes a number column with a string column', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('add-Person-id').fill('42')
    await page.getByTestId('add-Person-name').fill('mallory')
    await page.getByTestId('add-Person-submit').click()

    await expect(page.getByTestId('relation-count-Person')).toHaveText('7 rows')
    await expect(page.getByTestId('add-Person-id')).toHaveValue('')
    await expect(page.getByTestId('add-Person-name')).toHaveValue('')
    // Row appears in the people panel with the right name.
    await expect(page.getByTestId('person-42')).toHaveAttribute('data-name', 'mallory')
  })

  test('float column round-trips through a 4-way join', async ({ page }) => {
    await page.goto('/')
    // Seed weights: alice 62.5, bob 78.4, carol 55.1, dave 91.2, eve 67.8,
    // frank 70.0. ReachableWeight is the join of Me ⋈ Reach ⋈ Person ⋈
    // Weight, so it should surface bob/carol/dave/eve with their kg.
    await expect(page.getByTestId('relation-row-ReachableWeight-bob-78.4')).toBeVisible()
    await expect(page.getByTestId('relation-row-ReachableWeight-carol-55.1')).toBeVisible()
    await expect(page.getByTestId('relation-row-ReachableWeight-dave-91.2')).toBeVisible()
    await expect(page.getByTestId('relation-row-ReachableWeight-eve-67.8')).toBeVisible()
    // alice (= me) and frank (unreachable) shouldn't appear.
    await expect(page.getByTestId('relation-row-ReachableWeight-alice-62.5')).toHaveCount(0)
    await expect(page.getByTestId('relation-row-ReachableWeight-frank-70')).toHaveCount(0)
  })

  test('Weight add-row accepts decimal input', async ({ page }) => {
    await page.goto('/')
    // Float column input is type="number" step="any" — decimals fly through.
    await expect(page.getByTestId('add-Weight-kg')).toHaveAttribute('type', 'number')
    await expect(page.getByTestId('add-Weight-kg')).toHaveAttribute('step', 'any')

    await page.getByTestId('add-Weight-id').fill('99')
    await page.getByTestId('add-Weight-kg').fill('72.3')
    await page.getByTestId('add-Weight-kg').press('Enter')

    await expect(page.getByTestId('relation-count-Weight')).toHaveText('7 rows')
    // No friendship to 99 yet → still 4 ReachableWeight rows.
    await expect(page.getByTestId('relation-count-ReachableWeight')).toHaveText('4 rows')
  })

  test('add-row inputs get the right type per declared column', async ({ page }) => {
    await page.goto('/')
    // Numeric columns get type="number" so the browser rejects non-numeric
    // input before our codec ever sees it.
    await expect(page.getByTestId('add-Person-id')).toHaveAttribute('type', 'number')
    await expect(page.getByTestId('add-Me-id')).toHaveAttribute('type', 'number')
    await expect(page.getByTestId('add-Friend-a')).toHaveAttribute('type', 'number')
    // String columns stay on text so the user can type anything.
    await expect(page.getByTestId('add-Person-name')).toHaveAttribute('type', 'text')
  })

  test('editing the program enables rebuild; rebuilding preserves EDB state', async ({ page }) => {
    await page.goto('/')

    // Rebuild is disabled until the textarea diverges from the seed source.
    await expect(page.getByTestId('program-rebuild')).toBeDisabled()

    // Append a harmless second IDB rule: alias for ICanReach.
    const textarea = page.getByTestId('program-source')
    const current = await textarea.inputValue()
    const next = `${current}\n\n.out\n.decl Buddy(name: string)\n\nBuddy(n) :- ICanReach(n).\n`
    await textarea.fill(next)

    await expect(page.getByTestId('program-rebuild')).toBeEnabled()
    await page.getByTestId('program-rebuild').click()

    // The new IDB appears in the inspector with the same row count as
    // ICanReach (4 reachable), proving EDB state was replayed against
    // the new graph rather than reset to empty.
    await expect(page.getByTestId('relation-table-Buddy')).toBeVisible()
    await expect(page.getByTestId('relation-count-Buddy')).toHaveText('4 rows')
    await expect(page.getByTestId('relation-count-ICanReach')).toHaveText('4 rows')
    // Headline stats survived the swap.
    await expect(page.getByTestId('stat-people')).toHaveText('6')
    await expect(page.getByTestId('stat-friends')).toHaveText('4')
  })

  test('an invalid program shows a parse error and keeps the old session live', async ({ page }) => {
    await page.goto('/')

    const textarea = page.getByTestId('program-source')
    await textarea.fill('this is not valid datalog')
    await page.getByTestId('program-rebuild').click()

    // Error is surfaced inline.
    await expect(page.getByTestId('program-status')).toContainText(/expected|parse/i)
    // The old session is still answering queries.
    await expect(page.getByTestId('stat-reachable')).toHaveText('4')
    await expect(page.getByTestId('reachable-bob')).toBeVisible()
  })

  test('reset-to-seed restores the seed program and re-derives state', async ({ page }) => {
    await page.goto('/')

    const textarea = page.getByTestId('program-source')
    // Replace the program with an empty (but valid) one, then reset.
    await textarea.fill('.in\n.decl Person(id: number, name: string)\n\n.out\n.decl Pass(id: number)\n\nPass(id) :- Person(id, _).\n')
    await page.getByTestId('program-rebuild').click()
    await expect(page.getByTestId('relation-count-Pass')).toHaveText('6 rows')

    await page.getByTestId('program-reset').click()

    // Original IDBs come back; ICanReach derives the same 4 names.
    await expect(page.getByTestId('relation-table-ICanReach')).toBeVisible()
    await expect(page.getByTestId('relation-count-ICanReach')).toHaveText('4 rows')
    await expect(page.getByTestId('stat-reachable')).toHaveText('4')
  })
})
