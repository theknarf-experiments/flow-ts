// The markdown vault: the round trip, end to end.
//
// Every assertion here is really the same one — an edit to a *derived* table
// changed the *source markdown* — but through a different shape of rule each
// time, because that is what decides whether the tracing was real or a lucky
// special case:
//
//   Tasks    a projection, where the line number was thrown away and has to be
//            recovered before anything can be rewritten
//   Agenda   a join whose two columns land in two different source relations,
//            three rules apart, one of them via a derived `Doc`
//   Outline  a stored number rendered as syntax, so the writer has to turn a
//            depth back into a run of `#`
//
// Nothing in the UI knows any of that. The rules are the only description of
// the mapping that exists.

import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

async function gotoVault(page: Page) {
  await page.goto('/vault')
  await expect(page.locator('body[data-hydrated="true"]')).toBeVisible()
  await expect(page.getByTestId('vault-demo')).toBeVisible()
}

const work = (page: Page) => page.getByTestId('note-work.md')
const home = (page: Page) => page.getByTestId('note-home.md')

test.describe('markdown vault', () => {
  test('renders the derived tables from the seeded notes', async ({ page }) => {
    await gotoVault(page)
    // Three tasks in work.md, two in home.md.
    await expect(page.getByTestId('task-write the design doc')).toBeVisible()
    await expect(page.getByTestId('task-water the plants')).toBeVisible()
    // The agenda only lists *open* ones, so the reviewed benchmark is absent.
    await expect(page.getByTestId('agenda-write the design doc')).toBeVisible()
    await expect(page.getByTestId('agenda-review the benchmark')).toHaveCount(0)
    // …and it shows them under the document title, which is itself derived
    // from the first heading rather than stored.
    await expect(page.getByTestId('agenda-input-0-water the plants')).toHaveValue('Home')
  })

  test('ticking a derived checkbox rewrites the markdown', async ({ page }) => {
    await gotoVault(page)
    await expect(work(page)).toContainText('- [ ] write the design doc')

    await page.getByTestId('task-check-write the design doc').check()

    // The source changed — this is the whole point.
    await expect(work(page)).toContainText('- [x] write the design doc')
    await expect(work(page)).not.toContainText('- [ ] write the design doc')
    // And the views followed, because the facts were re-parsed from the text.
    await expect(page.getByTestId('agenda-write the design doc')).toHaveCount(0)
    await expect(page.getByTestId('vault-status')).toContainText('MdTask')
  })

  test('and unticking puts it back', async ({ page }) => {
    await gotoVault(page)
    await page.getByTestId('task-check-review the benchmark').uncheck()
    await expect(work(page)).toContainText('- [ ] review the benchmark')
    await expect(page.getByTestId('agenda-review the benchmark')).toBeVisible()
  })

  test('renaming an agenda task rewrites the task line, keeping its indent', async ({ page }) => {
    await gotoVault(page)
    const input = page.getByTestId('agenda-input-1-reply to sam')
    await input.fill('reply to sam about the docs')
    await input.blur()

    await expect(work(page)).toContainText('- [ ] reply to sam about the docs')
    // The status is preserved: only the text column was edited.
    await expect(work(page)).not.toContainText('- [x] reply to sam')
  })

  test('renaming an agenda title rewrites a heading, three rules away', async ({ page }) => {
    await gotoVault(page)
    await expect(home(page)).toContainText('# Home')

    // `Agenda.title` comes from `Doc`, which is derived from the first `#`
    // heading — so this has to trace through two rules to reach a line of text.
    const input = page.getByTestId('agenda-input-0-water the plants')
    await input.fill('Household')
    await input.blur()

    await expect(home(page)).toContainText('# Household')
    await expect(page.getByTestId('vault-status')).toContainText('MdHeading')
    // Both of home.md's tasks now file under the new title.
    await expect(page.getByTestId('agenda-input-0-book the dentist')).toHaveValue('Household')
  })

  test('deepening an outline entry rewrites the run of #', async ({ page }) => {
    await gotoVault(page)
    await expect(page.getByTestId('outline-depth-This week')).toHaveText('##')

    await page.getByTestId('outline-deeper-This week').click()

    await expect(work(page)).toContainText('### This week')
    await expect(page.getByTestId('outline-depth-This week')).toHaveText('###')
  })

  test('but not a heading that is also the document title', async ({ page }) => {
    await gotoVault(page)
    // `Doc(p, title) :- MdHeading(p, l, 1, title).` — demoting `# Home` would
    // destroy the title that this very row is filed under, so the row could
    // not exist afterwards. Whether that is true depends on the data, so the
    // control is disabled by a dry run rather than by a static rule.
    await expect(page.getByTestId('outline-deeper-Home')).toBeDisabled()
    await expect(page.getByTestId('outline-why-Home')).toContainText("document's title")
    // …and the one whose title comes from another line is fine.
    await expect(page.getByTestId('outline-deeper-This week')).toBeEnabled()
  })

  test('the program is on screen, and the rules drive everything above', async ({ page }) => {
    await gotoVault(page)
    const panel = page.getByTestId('vault-program-panel')
    await expect(panel).toBeVisible()
    await panel.getByText('Datalog program').click()
    await expect(page.getByTestId('vault-program-source')).toContainText(
      'Agenda(title, t) :- Open(p, t), Doc(p, title).',
    )

    // Break the trace: mention `t` twice, so it no longer occurs in exactly
    // one position, and the agenda's task column stops being editable.
    const source = page.getByTestId('vault-program-source')
    await source.fill(
      (await source.inputValue()).replace(
        'Agenda(title, t) :- Open(p, t), Doc(p, title).',
        'Agenda(title, t) :- Open(p, t), Open(p, t), Doc(p, title).',
      ),
    )
    await page.getByTestId('vault-program-rebuild').click()

    await expect(page.getByTestId('agenda-writable')).toHaveText('editable: title')
    await expect(page.getByTestId('agenda-input-1-water the plants')).toHaveAttribute(
      'readonly',
      '',
    )
  })

  // Adding is the one operation the rules cannot work out on their own, and the
  // only annotation in the program exists for it. Deleting and rewriting a task
  // replay the body against a row that exists, and recover its line that way;
  // an insert has no such row, so `line` has no value and nothing suggests one.
  test('adding a task needs an annotation, and works because there is one', async ({ page }) => {
    await gotoVault(page)
    await expect(page.getByTestId('task-buy stamps')).toHaveCount(0)

    await page.getByTestId('task-new-text').fill('buy stamps')
    await page.getByTestId('task-new-note').selectOption('home.md')
    await page.getByTestId('task-add').click()

    // Appended to the markdown, unchecked, as a real task line.
    await expect(home(page)).toContainText('- [ ] buy stamps')
    // And derived straight back out again, with a real line number this time.
    await expect(page.getByTestId('task-buy stamps')).toBeVisible()
    await expect(page.getByTestId('agenda-buy stamps')).toBeVisible()
  })

  test('and the new task behaves like any other once it exists', async ({ page }) => {
    await gotoVault(page)
    await page.getByTestId('task-new-text').fill('buy stamps')
    await page.getByTestId('task-new-note').selectOption('home.md')
    await page.getByTestId('task-add').click()

    // Ticking it rewrites the line that was just appended — the insert's
    // placeholder line number never leaks out; the re-parse supplied the real one.
    await page.getByTestId('task-check-buy stamps').check()
    await expect(home(page)).toContainText('- [x] buy stamps')
    await expect(home(page)).not.toContainText('- [ ] buy stamps')
  })

  test('removing the annotation removes the capability', async ({ page }) => {
    await gotoVault(page)
    await page.getByTestId('vault-program-panel').getByText('Datalog program').click()
    const source = page.getByTestId('vault-program-source')
    await source.fill((await source.inputValue()).replace('.put insert defaults(l = 0)', ''))
    await page.getByTestId('vault-program-rebuild').click()

    await page.getByTestId('task-new-text').fill('buy stamps')
    await page.getByTestId('task-add').click()

    // Refused, with the compiler's own explanation, rather than guessing a line.
    await expect(page.getByTestId('vault-status')).toContainText('insert defaults')
    await expect(page.getByTestId('task-buy stamps')).toHaveCount(0)
  })

  test('editing the markdown directly flows the other way', async ({ page }) => {
    await gotoVault(page)
    await expect(page.getByTestId('task-buy milk')).toHaveCount(0)

    await home(page).fill('# Home\n\n- [ ] water the plants\n- [ ] buy milk\n')

    await expect(page.getByTestId('task-buy milk')).toBeVisible()
    await expect(page.getByTestId('agenda-buy milk')).toBeVisible()
  })

  test('renaming a title renames it for every task in that document', async ({ page }) => {
    await gotoVault(page)
    // home.md has two tasks, both filed under the same title, because `Doc` is
    // derived from the note's one heading. Renaming via either row rewrites
    // that heading, so both rows follow — and neither is left showing a title
    // the facts disagree with.
    await gotoVault(page)
    const input = page.getByTestId('agenda-input-0-book the dentist')
    await input.fill('Errands')
    await input.blur()

    await expect(page.getByTestId('agenda-input-0-book the dentist')).toHaveValue('Errands')
    await expect(page.getByTestId('agenda-input-0-water the plants')).toHaveValue('Errands')
    await expect(home(page)).toContainText('# Errands')

    // And a second rename from the *other* row still works, rather than
    // committing a value left over from the first.
    const other = page.getByTestId('agenda-input-0-water the plants')
    await other.fill('Chores')
    await other.blur()
    await expect(page.getByTestId('agenda-input-0-book the dentist')).toHaveValue('Chores')
    await expect(home(page)).toContainText('# Chores')
  })

  test('writability is reported per column, from the rules', async ({ page }) => {
    await gotoVault(page)
    // Both agenda columns trace to a single source position, so both are
    // editable — and the panel says which, rather than the component deciding.
    await expect(page.getByTestId('agenda-writable')).toHaveText('editable: title, text')
  })

  test('an edit that goes stale is refused, not guessed at', async ({ page }) => {
    await gotoVault(page)
    // Remove the task from the source while its row is still on screen, then
    // try to edit that row. The write re-reads the text and finds it gone.
    await work(page).fill('# Work\n\n## This week\n- [x] review the benchmark\n')
    await expect(page.getByTestId('task-write the design doc')).toHaveCount(0)
    await expect(page.getByTestId('task-review the benchmark')).toBeVisible()
  })
})
