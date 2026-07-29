// The tutorial, driven the way a reader would drive it.
//
// `tests/lessons.test.ts` already checks that every lesson's program derives
// the rows its prose claims. What it can't check is that the page in front of
// the reader shows them, that editing a fact updates the derived tables without
// a reload, and that the rules really are live-editable — which is most of what
// the lessons tell people to go and do. That is this file.
//
// It deliberately does not re-assert every lesson's answers. The unit suite
// owns those; duplicating them here would mean two places to update and a slow
// suite that finds nothing the fast one didn't.

import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

async function goto(page: Page, path: string) {
  await page.goto(path)
  await expect(page.locator('body[data-hydrated="true"]')).toBeVisible()
}

const lesson = (page: Page, slug: string) => goto(page, `/learn/${slug}`)

/** Cell values of one column of a relation table, as rendered. */
async function column(page: Page, relation: string, index: number): Promise<string[]> {
  const cells = page
    .getByTestId(`relation-table-${relation}`)
    .locator(`tbody tr td:nth-child(${index + 1})`)
  return (await cells.allTextContents()).map((t) => t.trim())
}

test.describe('navigation', () => {
  test('the sidebar lists the tutorial in order and links to the demos', async ({ page }) => {
    await goto(page, '/')
    const lessons = page.getByTestId('sidenav-lessons').locator('a')
    await expect(lessons).toHaveCount(14)
    await expect(lessons.first()).toContainText('Facts and rules')
    await expect(lessons.last()).toContainText('.put into')
    await expect(page.getByTestId('sidenav-lessons').locator('> li')).toHaveCount(11)
    await expect(page.getByTestId('sidenav').getByRole('link', { name: 'Markdown vault' })).toBeVisible()
  })

  test('the write-back refinements are nested under it, and numbered within it', async ({
    page,
  }) => {
    await goto(page, '/')
    const sub = page.getByTestId('sidenav-lessons').locator('.sidenav-sub a')
    await expect(sub).toHaveCount(3)
    // Numbered inside their parent, not after it — the tutorial is eleven
    // steps, one of which has three parts.
    await expect(sub.first()).toContainText('11.1')
    await expect(sub.last()).toContainText('11.3')
    // …so the last top-level step is still 11.
    const top = page.getByTestId('sidenav-lessons').locator('> li > a')
    await expect(top).toHaveCount(11)
    await expect(top.last()).toContainText('11')
  })

  test('the overview lists every lesson, and a card navigates', async ({ page }) => {
    await goto(page, '/')
    await expect(page.getByTestId('lesson-list').locator('a')).toHaveCount(14)
    await page.getByTestId('lesson-link-joins').click()
    await expect(page).toHaveURL(/\/learn\/joins$/)
    await expect(page.getByRole('heading', { name: 'Joins' })).toBeVisible()
  })

  test('a refinement names its parent, and the parent links to its refinements', async ({
    page,
  }) => {
    await lesson(page, 'write-back')
    const children = page.getByTestId('lesson-children').locator('a')
    await expect(children).toHaveCount(3)
    await children.first().click()
    await expect(page).toHaveURL(/\/learn\/put-insert$/)
    // A refinement names its parent instead of claiming a place in the count.
    await expect(page.getByTestId('lesson-number')).toContainText('Lesson 11.1')
    await expect(page.getByTestId('lesson-number')).toContainText('Writing back')
    await expect(page.getByTestId('lesson-number')).not.toContainText('of 11')
  })

  test('lessons chain forward and back', async ({ page }) => {
    await lesson(page, 'filters')
    const nav = page.getByTestId('lesson-nav')
    await nav.getByRole('link', { name: /Arithmetic/ }).click()
    await expect(page).toHaveURL(/\/learn\/arithmetic$/)
    await page.getByTestId('lesson-nav').getByRole('link', { name: /Filters/ }).click()
    await expect(page).toHaveURL(/\/learn\/filters$/)
  })

  test('an unknown slug offers the list rather than blowing up', async ({ page }) => {
    await goto(page, '/learn/does-not-exist')
    await expect(page.getByRole('heading', { name: 'No such lesson' })).toBeVisible()
  })
})

test.describe('lessons render what they derive', () => {
  test('facts: four people, three ages', async ({ page }) => {
    await lesson(page, 'facts')
    await expect(page.getByTestId('relation-count-Person')).toHaveText('4 rows')
    await expect(page.getByTestId('relation-count-Name')).toHaveText('4 rows')
    // The claim the prose makes: projecting away the name collapses the two 17s.
    await expect(page.getByTestId('relation-count-Age')).toHaveText('3 rows')
  })

  test('joins: the parrot has no vet, so carol has no clinic', async ({ page }) => {
    await lesson(page, 'joins')
    await expect(page.getByTestId('relation-count-Owns')).toHaveText('4 rows')
    const names = await column(page, 'Clinic', 0)
    expect(names).not.toContain('carol')
  })

  test('aggregation: the group key is whatever else the head carries', async ({ page }) => {
    await lesson(page, 'aggregation')
    await expect(page.getByTestId('relation-count-Revenue')).toHaveText('3 rows')
    // A head with no group-by column aggregates the lot into one row.
    await expect(page.getByTestId('relation-count-Overall')).toHaveText('1 row')
  })
})

test.describe('the tables are live', () => {
  test('adding a fact updates the derived tables without a reload', async ({ page }) => {
    await lesson(page, 'joins')
    await expect(page.getByTestId('relation-count-Clinic')).toHaveText('5 rows')

    // Give the parrot a vet, as the lesson suggests.
    await page.getByTestId('add-Vet-species').fill('parrot')
    await page.getByTestId('add-Vet-clinic').fill('Featherworks')
    await page.getByTestId('add-Vet-submit').click()

    await expect(page.getByTestId('relation-count-Clinic')).toHaveText('6 rows')
    expect(await column(page, 'Clinic', 0)).toContain('carol')
  })

  test('retracting a fact retracts what depended on it, transitively', async ({ page }) => {
    await lesson(page, 'incremental')
    await expect(page.getByTestId('relation-count-FromHome')).toHaveText('4 rows')

    // Cutting one of the two paths to `api` changes nothing…
    await page.getByRole('button', { name: 'remove Link docs api' }).click()
    await expect(page.getByTestId('relation-count-FromHome')).toHaveText('4 rows')

    // …and cutting the other takes `api` and `guide` with it.
    await page.getByRole('button', { name: 'remove Link blog api' }).click()
    await expect(page.getByTestId('relation-count-FromHome')).toHaveText('2 rows')
    expect(await column(page, 'FromHome', 0)).toEqual(expect.arrayContaining(['blog', 'docs']))
  })
})

test.describe('the rules are editable', () => {
  test('rebuilding with a new rule surfaces a new table, and facts replay', async ({ page }) => {
    await lesson(page, 'facts')
    const source = page.getByTestId('program-source')
    const current = await source.inputValue()
    await source.fill(
      current.replace('.decl Age(age: number)', '.decl Age(age: number)\n.decl Tall(name: string)')
        .replace('Age(a) :- Person(n, a, h).', 'Age(a) :- Person(n, a, h).\nTall(n) :- Person(n, a, h).'),
    )
    await page.getByTestId('program-rebuild').click()

    await expect(page.getByTestId('relation-table-Tall')).toBeVisible()
    // The facts survived the rebuild — that is what makes rule edits usable.
    await expect(page.getByTestId('relation-count-Tall')).toHaveText('4 rows')
    await expect(page.getByTestId('relation-count-Person')).toHaveText('4 rows')
  })

  test('a program that does not parse reports instead of crashing', async ({ page }) => {
    await lesson(page, 'facts')
    await page.getByTestId('program-source').fill('this is not datalog')
    await page.getByTestId('program-rebuild').click()
    await expect(page.getByTestId('program-status').locator('.program-error')).toBeVisible()
    // The old program is still running underneath.
    await expect(page.getByTestId('relation-count-Person')).toHaveText('4 rows')
  })
})

test.describe('ad-hoc queries', () => {
  test('runs a program the store has never seen', async ({ page }) => {
    await lesson(page, 'queries')
    await expect(page.getByTestId('console-results')).toBeVisible()
    // The pre-filled query sums salaries per department.
    await expect(page.getByTestId('console-row-Payroll-eng, 260')).toBeVisible()
    await expect(page.getByTestId('console-row-Payroll-ops, 200')).toBeVisible()
  })

  test('re-runs when the facts change', async ({ page }) => {
    await lesson(page, 'queries')
    await expect(page.getByTestId('console-row-Payroll-design, 110')).toBeVisible()
    await page.getByRole('button', { name: 'remove Salary 5 110' }).click()
    await expect(page.getByTestId('console-row-Payroll-design, 110')).toHaveCount(0)
  })

  test('shows a parse error rather than throwing', async ({ page }) => {
    await lesson(page, 'queries')
    await page.getByTestId('console-source').fill('Payroll(d) :- nonsense')
    await expect(page.getByTestId('console-error')).toBeVisible()
  })

  test('a `?-` rule needs no declaration, and the long form gives the same answer', async ({
    page,
  }) => {
    await lesson(page, 'queries')
    const source = page.getByTestId('console-source')
    // The pre-filled query is already the shorthand.
    expect(await source.inputValue()).toContain('?-')
    await expect(page.getByTestId('console-row-Payroll-eng, 260')).toBeVisible()

    // Spelled out: a section header, a declaration with column types, the rule.
    await source.fill(
      '.out\n.decl Payroll(dept: string, total: number)\n\n' +
        'Payroll(d, sum(s)) :- Person(i, n, d), Salary(i, s).\n',
    )
    await expect(page.getByTestId('console-row-Payroll-eng, 260')).toBeVisible()
  })

  test('a bare goal needs no head at all, and names itself', async ({ page }) => {
    await lesson(page, 'queries')
    await page.getByTestId('console-source').fill('?- Person(i, n, d), Salary(i, s), s > 100.\n')
    // Every variable the body binds, in order, under a made-up name.
    await expect(page.getByTestId('console-row-Query1-1, alice, eng, 140')).toBeVisible()
    await expect(page.getByTestId('console-row-Query1-2, bob, eng, 120')).toBeVisible()
    // carol is on 95.
    await expect(page.getByTestId('console-results')).not.toContainText('carol')
  })

  test('a bare goal drops the columns marked `_`', async ({ page }) => {
    await lesson(page, 'queries')
    await page.getByTestId('console-source').fill('?- Person(_, n, _).\n')
    await expect(page.getByTestId('console-row-Query1-alice')).toBeVisible()
    await expect(page.getByTestId('console-row-Query1-erin')).toBeVisible()
  })

  test('but reports the join key, because a key has to be named to join', async ({ page }) => {
    await lesson(page, 'queries')
    await page.getByTestId('console-source').fill('?- Person(i, n, d), Salary(i, s).\n')
    await expect(page.getByTestId('console-row-Query1-1, alice, eng, 140')).toBeVisible()
  })

  test('two `?-` rules over one head are a union', async ({ page }) => {
    await lesson(page, 'queries')
    await page.getByTestId('console-source').fill(
      '?- Who(n) :- Person(i, n, "eng").\n?- Who(n) :- Person(i, n, "ops").\n',
    )
    for (const name of ['alice', 'bob', 'carol', 'dave']) {
      await expect(page.getByTestId(`console-row-Who-${name}`)).toBeVisible()
    }
  })
})

test.describe('writing back', () => {
  test('an edit to a derived row lands on the fact behind it', async ({ page }) => {
    await lesson(page, 'write-back')
    const cell = page.getByTestId('writable-cell-Roster-alice-eng-0')
    await cell.fill('alicia')
    await cell.press('Enter')

    await expect(page.getByTestId('writable-status-Roster')).toContainText('Employee')
    // The write landed on the Employee fact, id intact.
    expect(await column(page, 'Employee', 1)).toContain('alicia')
  })

  test('an insert is refused until a default supplies the dropped column', async ({ page }) => {
    await lesson(page, 'write-back')
    await page.getByTestId('writable-add-Roster-name').fill('erin')
    await page.getByTestId('writable-add-Roster-dept').fill('design')
    await page.getByTestId('writable-add-Roster-submit').click()
    await expect(page.getByTestId('writable-status-Roster')).toContainText('.put insert defaults')

    // Lesson 12 is the same view with the annotation added.
    await lesson(page, 'put-insert')
    await page.getByTestId('writable-add-Roster-name').fill('erin')
    await page.getByTestId('writable-add-Roster-dept').fill('design')
    await page.getByTestId('writable-add-Roster-submit').click()
    await expect(page.getByTestId('writable-status-Roster')).toContainText('1 change to Employee')
    expect(await column(page, 'Employee', 1)).toContain('erin')
  })

  test('`via` picks which rule of a multi-rule head an insert satisfies', async ({ page }) => {
    await lesson(page, 'put-insert')
    await page.getByTestId('writable-add-Worker-name').fill('erin')
    await page.getByTestId('writable-add-Worker-submit').click()
    await expect(page.getByTestId('writable-status-Worker')).toContainText('Contractor')
    // …with that rule's default for the column the head doesn't carry.
    expect(await column(page, 'Contractor', 1)).toContain('unassigned')
  })

  test('an aggregate edit is distributed across the rows behind it', async ({ page }) => {
    await lesson(page, 'put-spread')
    const cell = page.getByTestId('writable-cell-Booked-alice-32-1')
    await cell.fill('40')
    await cell.press('Enter')

    await expect(page.getByTestId('writable-status-Booked')).toContainText('Hours')
    // 32 → 40 over two weeks: +4 each.
    const hours = await column(page, 'Hours', 2)
    expect(hours).toContain('16')
    expect(hours).toContain('24')
  })

  test('a max() aggregate is read-only — spread only inverts sum', async ({ page }) => {
    await lesson(page, 'put-spread')
    await expect(page.getByTestId('writable-cell-Peak-alice-20-1')).toHaveAttribute('readonly', '')
  })

  test('`into` names the side of a join a delete lands on', async ({ page }) => {
    await lesson(page, 'put-into')
    // The held side is not writable at all, which is the compiler's answer
    // rather than this page's.
    await expect(page.getByTestId('writable-cell-WhoLeads-alice-frida-1')).toHaveAttribute(
      'readonly',
      '',
    )

    await page.getByTestId('writable-remove-WhoLeads-alice-frida').click()
    await expect(page.getByTestId('writable-status-WhoLeads')).toContainText('1 change to Employee')
    expect(await column(page, 'Employee', 1)).not.toContain('alice')
  })

  test('without it the same delete is ambiguous, and says so', async ({ page }) => {
    await lesson(page, 'put-into')
    const source = page.getByTestId('program-source')
    await source.fill((await source.inputValue()).replace('.put into Employee\n', ''))
    await page.getByTestId('program-rebuild').click()

    // The lead column comes back, because nothing is held constant now.
    await expect(page.getByTestId('writable-cell-WhoLeads-alice-frida-1')).not.toHaveAttribute(
      'readonly',
      '',
    )
    await page.getByTestId('writable-remove-WhoLeads-alice-frida').click()
    await expect(page.getByTestId('writable-status-WhoLeads')).toContainText('ambiguous')
    await expect(page.getByTestId('writable-status-WhoLeads')).toContainText('Employee, Team')
  })

  test('a read-only view refuses by name', async ({ page }) => {
    await lesson(page, 'put-into')
    // `.put none` makes every column non-writable, so the cells are read-only —
    // the affordance comes from the compiler rather than from a guess here.
    await expect(page.getByTestId('writable-cell-Headcount-eng-2-1')).toHaveAttribute('readonly', '')
    await page.getByTestId('writable-remove-Headcount-eng-2').click()
    await expect(page.getByTestId('writable-status-Headcount')).toContainText('.put none')
  })
})

test.describe('theme', () => {
  test('defaults to the system preference and cycles on click', async ({ page }) => {
    await goto(page, '/')
    const html = page.locator('html')
    const toggle = page.getByTestId('theme-toggle')

    await expect(toggle).toHaveAttribute('data-preference', 'system')
    await expect(html).toHaveAttribute('data-theme', /light|dark/)

    await toggle.click()
    await expect(toggle).toHaveAttribute('data-preference', 'light')
    await expect(html).toHaveAttribute('data-theme', 'light')

    await toggle.click()
    await expect(toggle).toHaveAttribute('data-preference', 'dark')
    await expect(html).toHaveAttribute('data-theme', 'dark')

    await toggle.click()
    await expect(toggle).toHaveAttribute('data-preference', 'system')
  })

  test('survives a reload, and is applied before first paint', async ({ page }) => {
    await goto(page, '/')
    await page.getByTestId('theme-toggle').click() // → light
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

    await page.reload()
    // Set by the inline `<head>` script, so it is already right when the
    // document loads rather than corrected by an effect afterwards.
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect(page.getByTestId('theme-toggle')).toHaveAttribute('data-preference', 'light')
  })
})
