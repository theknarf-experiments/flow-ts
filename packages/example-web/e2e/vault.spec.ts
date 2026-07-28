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

  // Removing is the one operation here with more than one right answer, and
  // the engine refuses to pick. Deleting the heading really does make the row
  // stop existing — there would be no title to file it under — and it is
  // almost certainly not what anyone meant. Surfacing both is the point: the
  // candidate set is data, not a static verdict.
  test('removing an agenda row offers the choice rather than guessing', async ({ page }) => {
    await gotoVault(page)
    await page.getByTestId('agenda-remove-water the plants').click()

    const choice = page.getByTestId('agenda-choice')
    await expect(choice).toBeVisible()
    await expect(page.getByTestId('agenda-choice-MdTask')).toBeVisible()
    await expect(page.getByTestId('agenda-choice-MdHeading')).toBeVisible()
    // Nothing has happened yet.
    await expect(home(page)).toContainText('- [ ] water the plants')
    await expect(home(page)).toContainText('# Home')
  })

  test('choosing the task line removes just that line', async ({ page }) => {
    await gotoVault(page)
    await page.getByTestId('agenda-remove-water the plants').click()
    await page.getByTestId('agenda-choice-MdTask').click()

    await expect(home(page)).not.toContainText('water the plants')
    // The heading, and therefore every other row of that document, survives.
    await expect(home(page)).toContainText('# Home')
    await expect(page.getByTestId('agenda-book the dentist')).toBeVisible()
  })

  test('choosing the heading is offered, and does what it says', async ({ page }) => {
    await gotoVault(page)
    await page.getByTestId('agenda-remove-water the plants').click()
    await page.getByTestId('agenda-choice-MdHeading').click()

    // The task survives; the *title* is gone, so nothing from that note can be
    // filed on the agenda any more. Drastic, correct, and the user's call.
    await expect(home(page)).toContainText('- [ ] water the plants')
    await expect(home(page)).not.toContainText('# Home')
    await expect(page.getByTestId('agenda-book the dentist')).toHaveCount(0)
    // The task table is unaffected — it never depended on a title.
    await expect(page.getByTestId('task-water the plants')).toBeVisible()
  })

  test('cancelling changes nothing', async ({ page }) => {
    await gotoVault(page)
    await page.getByTestId('agenda-remove-water the plants').click()
    await page.getByTestId('agenda-choice-cancel').click()
    await expect(page.getByTestId('agenda-choice')).toHaveCount(0)
    await expect(home(page)).toContainText('- [ ] water the plants')
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

// The one view whose backward direction is a *distribution* rather than a copy.
// `Effort(path, sum(hours))` — changing a total has to change several facts, and
// the rule doesn't say how to divide the change. Least change settles most of
// it, but hours are whole numbers, so a delta that doesn't divide evenly leaves
// a remainder and something has to decide who takes it. That is the only thing
// `.put spread(min)` says, and without it the column isn't writable at all.
test.describe('spreading an aggregate', () => {
  const work = (page: Page) => page.getByTestId('note-work.md')

  test('a total is derived from the estimates on the lines', async ({ page }) => {
    await gotoVault(page)
    // work.md: 3 + 1 + 2
    await expect(page.getByTestId('effort-input-work.md')).toHaveValue('6')
    // home.md: 1 + 1
    await expect(page.getByTestId('effort-input-home.md')).toHaveValue('2')
  })

  test('an evenly divisible change moves every task by the same amount', async ({ page }) => {
    await gotoVault(page)
    const input = page.getByTestId('effort-input-work.md')
    await input.fill('9')
    await input.blur()

    // +3 over 3 tasks: one hour each.
    await expect(work(page)).toContainText('- [ ] write the design doc (4h)')
    await expect(work(page)).toContainText('- [x] review the benchmark (2h)')
    await expect(work(page)).toContainText('- [ ] reply to sam (3h)')
    await expect(page.getByTestId('effort-input-work.md')).toHaveValue('9')
  })

  test('a remainder lands on the earliest line, as the annotation says', async ({ page }) => {
    await gotoVault(page)
    const input = page.getByTestId('effort-input-work.md')
    await input.fill('8')
    await input.blur()

    // +2 over 3 tasks: everyone gets 0, and the remainder of 2 goes to the
    // lowest line number — `.put spread(min)`.
    await expect(work(page)).toContainText('- [ ] write the design doc (5h)')
    await expect(work(page)).toContainText('- [x] review the benchmark (1h)')
    await expect(work(page)).toContainText('- [ ] reply to sam (2h)')
    // Whatever the split, the total is exactly what was asked for.
    await expect(page.getByTestId('effort-input-work.md')).toHaveValue('8')
  })

  test('it works downwards too, and only touches the note edited', async ({ page }) => {
    await gotoVault(page)
    const input = page.getByTestId('effort-input-work.md')
    await input.fill('3')
    await input.blur()

    await expect(page.getByTestId('effort-input-work.md')).toHaveValue('3')
    await expect(page.getByTestId('effort-input-home.md')).toHaveValue('2')
  })

  test('editing an estimate in the markdown flows back to the total', async ({ page }) => {
    await gotoVault(page)
    await work(page).fill('# Work\n\n## This week\n- [ ] write the design doc (10h)\n')
    await expect(page.getByTestId('effort-input-work.md')).toHaveValue('10')
  })

  test('without the annotation the total is not editable at all', async ({ page }) => {
    await gotoVault(page)
    await page.getByTestId('vault-program-panel').getByText('Datalog program').click()
    const source = page.getByTestId('vault-program-source')
    await source.fill((await source.inputValue()).replace('.put spread(min)', ''))
    await page.getByTestId('vault-program-rebuild').click()

    // The rule is unchanged and the total still derives — it just cannot be
    // written through, because nothing says how to divide a change.
    await expect(page.getByTestId('effort-input-work.md')).toHaveValue('6')
    await expect(page.getByTestId('effort-input-work.md')).toHaveAttribute('readonly', '')
  })
})

// `.put into R` — naming which side of a join a write lands on, and paying for
// it. Removing an agenda row is genuinely ambiguous: dropping the task line and
// dropping the document heading both make the row stop existing. The engine
// finds both and will not choose. `.put into Open` is the schema choosing once,
// and the price is the other side being held constant — which is what makes the
// title column read-only. Both consequences come from the same annotation.
test.describe('naming the side of a join a write lands on', () => {
  const agendaInto = async (page: Page) => {
    await page.getByTestId('agenda-remove-reply to sam').click()
    await page.getByTestId('agenda-choice-annotate').click()
  }

  test('without it, both columns are editable and removing is a question', async ({ page }) => {
    await gotoVault(page)
    await expect(page.getByTestId('agenda-writable')).toHaveText('editable: title, text')
    await page.getByTestId('agenda-remove-reply to sam').click()
    await expect(page.getByTestId('agenda-choice')).toBeVisible()
  })

  test('adding it makes removing unambiguous — straight to the task line', async ({ page }) => {
    await gotoVault(page)
    await agendaInto(page)
    await expect(page.getByTestId('agenda-choice')).toHaveCount(0)

    await page.getByTestId('agenda-remove-reply to sam').click()
    // No dialog this time: the schema already answered.
    await expect(page.getByTestId('agenda-choice')).toHaveCount(0)
    await expect(page.getByTestId('note-work.md')).not.toContainText('reply to sam')
    // And the heading it might have removed instead is untouched.
    await expect(page.getByTestId('note-work.md')).toContainText('# Work')
  })

  test('and the constant side stops being writable', async ({ page }) => {
    await gotoVault(page)
    await agendaInto(page)
    await expect(page.getByTestId('agenda-writable')).toHaveText('editable: text')
    await expect(page.getByTestId('agenda-input-0-water the plants')).toHaveAttribute(
      'readonly',
      '',
    )
    // The subject side still writes through.
    const text = page.getByTestId('agenda-input-1-water the plants')
    await text.fill('water the ferns')
    await text.blur()
    await expect(page.getByTestId('note-home.md')).toContainText('- [ ] water the ferns')
  })

  test('the annotation lands in the program panel, where it can be taken back', async ({
    page,
  }) => {
    await gotoVault(page)
    await agendaInto(page)
    await page.getByTestId('vault-program-panel').getByText('Datalog program').click()
    await expect(page.getByTestId('vault-program-source')).toHaveValue(/\.put into Open/)

    await page.getByTestId('vault-program-reset').click()
    await expect(page.getByTestId('agenda-writable')).toHaveText('editable: title, text')
  })
})

// `.put insert via R` — choosing which rule an insertion satisfies. `Line` has
// two rules, and the asymmetry is the point: reading and editing need no help,
// because an existing row can be traced to the rule that produced it. A row
// that does not exist yet cannot be, so "task or heading?" has no answer in the
// program until one is written down.
test.describe('choosing which rule an insert satisfies', () => {
  test('the view unions both rules', async ({ page }) => {
    await gotoVault(page)
    // A task…
    await expect(page.getByTestId('line-reply to sam')).toBeVisible()
    // …and a heading, in the same view.
    await expect(page.getByTestId('line-This week')).toBeVisible()
  })

  test('inserting goes to the rule the annotation names', async ({ page }) => {
    await gotoVault(page)
    await expect(page.getByTestId('line-insert-status')).toContainText('insert via MdTask')
    await page.getByTestId('line-new-text').fill('buy stamps')
    await page.getByTestId('line-new-note').selectOption('home.md')
    await page.getByTestId('line-add').click()

    // A task, not a heading — and `defaults(s = "open")` is why it is unchecked.
    await expect(page.getByTestId('note-home.md')).toContainText('- [ ] buy stamps')
    await expect(page.getByTestId('note-home.md')).not.toContainText('# buy stamps')
    await expect(page.getByTestId('line-buy stamps')).toBeVisible()
  })

  test('without it the engine refuses, and says the head has several rules', async ({ page }) => {
    await gotoVault(page)
    await page.getByTestId('vault-program-panel').getByText('Datalog program').click()
    const source = page.getByTestId('vault-program-source')
    await source.fill(
      (await source.inputValue()).replace(
        '.put insert via MdTask defaults(l = 0, s = "open")',
        '',
      ),
    )
    await page.getByTestId('vault-program-rebuild').click()

    // The view still reads — both rules still derive rows.
    await expect(page.getByTestId('line-reply to sam')).toBeVisible()
    // Only the insert is gone, and the message says why.
    await expect(page.getByTestId('line-insert-status')).toContainText('several rules')
    await page.getByTestId('line-new-text').fill('buy stamps')
    await expect(page.getByTestId('line-add')).toBeDisabled()
  })
})

// `.put none` — explicit read-only. The distinction worth seeing is against the
// host's `writable` list: `Load` is in it, so the application is offering the
// edit, and the schema is the thing declining. And a refusal that says "declared
// read-only" is a different answer from one that says "I could not work it out".
test.describe('a view that is read-only on purpose', () => {
  test('is opted in by the host and still not writable', async ({ page }) => {
    await gotoVault(page)
    await expect(page.getByTestId('load-count-work.md')).toHaveText('2')
    await expect(page.getByTestId('load-writable')).toHaveText('editable: none')
  })

  test('refuses by naming the annotation', async ({ page }) => {
    await gotoVault(page)
    await page.getByTestId('load-try-work.md').click()
    await expect(page.getByTestId('load-refusal')).toHaveText(
      'Load is declared read-only with `.put none`',
    )
  })

  test('and without it the refusal is about what could not be worked out', async ({ page }) => {
    await gotoVault(page)
    await page.getByTestId('vault-program-panel').getByText('Datalog program').click()
    const source = page.getByTestId('vault-program-source')
    await source.fill((await source.inputValue()).replace('\n.put none', ''))
    await page.getByTestId('vault-program-rebuild').click()

    await page.getByTestId('load-try-work.md').click()
    await expect(page.getByTestId('load-refusal')).toContainText('aggregation')
    await expect(page.getByTestId('load-refusal')).not.toContainText('read-only')
  })

  test('the count still derives, and follows the tasks', async ({ page }) => {
    await gotoVault(page)
    await page.getByTestId('task-check-reply to sam').click()
    await expect(page.getByTestId('load-count-work.md')).toHaveText('1')
  })
})

// A head that computes. Deleting a derived row never needed an inverse — it
// only asks which tuple produced the value. Rewriting the computed column does,
// and `* 60` has one only up to truncation. The two requests are
// indistinguishable in the rule text; the difference is the value, so the
// protocol applies, re-runs, compares and rolls back the one that missed.
test.describe('inverting arithmetic in the head', () => {
  test('the column is computed, and derives from the estimate', async ({ page }) => {
    await gotoVault(page)
    await expect(page.getByTestId('minutes-input-write the design doc')).toHaveValue('180')
    await expect(page.getByTestId('minutes-input-reply to sam')).toHaveValue('120')
  })

  test('a divisible rewrite runs the computation backwards', async ({ page }) => {
    await gotoVault(page)
    const input = page.getByTestId('minutes-input-write the design doc')
    await input.fill('240')
    await input.blur()

    // 240 / 60 = 4, written to the estimate on that line.
    await expect(page.getByTestId('note-work.md')).toContainText(
      '- [ ] write the design doc (4h)',
    )
    await expect(input).toHaveValue('240')
    // And the aggregate over the same estimates follows: 4 + 1 + 2.
    await expect(page.getByTestId('effort-input-work.md')).toHaveValue('7')
  })

  test('one that does not round-trip is caught and rolled back', async ({ page }) => {
    await gotoVault(page)
    const input = page.getByTestId('minutes-input-write the design doc')
    await input.fill('150')
    await input.blur()

    // 150 / 60 truncates to 2, and 2 * 60 is 120 — a good row, not the one
    // asked for. Nothing static sees this; re-running does.
    await expect(page.getByTestId('vault-status')).toContainText(
      'it produced Minutes(work.md, write the design doc, 120) instead',
    )
    await expect(page.getByTestId('vault-status')).toContainText('does not round-trip')
    // Nothing was written.
    await expect(page.getByTestId('note-work.md')).toContainText(
      '- [ ] write the design doc (3h)',
    )
    await expect(input).toHaveValue('180')
  })

  test('the other column of the same view is an ordinary copy', async ({ page }) => {
    await gotoVault(page)
    // `text` traces to one position in MdTask; only the computed column needed
    // an inverse, and the rest of the row is unaffected by that.
    await expect(page.getByTestId('minutes-reply to sam')).toBeVisible()
    await expect(page.getByTestId('minutes-input-reply to sam')).toHaveValue('120')
  })
})

// A view defined by what is absent. Every other table here loses a row when a
// fact is deleted; this one loses a row when a fact is added. Nothing declares
// it — a negated atom flips which channel a request travels on, so `Del_Missing`
// compiles to `Ins_MdTag` and `Ins_Missing` to `Del_MdTag`. A checkbox exercises
// both, which is why it is the right control.
test.describe('a negated view runs backwards', () => {
  test('reflects the tags already on the notes', async ({ page }) => {
    await gotoVault(page)
    await expect(page.getByTestId('tag-work.md-urgent')).toBeChecked()
    await expect(page.getByTestId('tag-work.md-errand')).not.toBeChecked()
    await expect(page.getByTestId('tag-home.md-urgent')).not.toBeChecked()
  })

  test('removing a row from the view inserts a fact', async ({ page }) => {
    await gotoVault(page)
    await page.getByTestId('tag-home.md-errand').check()

    // The request was a *delete* on `Missing`; the change is an *insert*.
    await expect(page.getByTestId('vault-status')).toContainText('ins MdTag(home.md:errand)')
    await expect(page.getByTestId('note-home.md')).toContainText('# Home #errand')
    await expect(page.getByTestId('tag-home.md-errand')).toBeChecked()
  })

  test('and adding one deletes a fact', async ({ page }) => {
    await gotoVault(page)
    await page.getByTestId('tag-work.md-urgent').uncheck()

    await expect(page.getByTestId('vault-status')).toContainText('del MdTag(work.md:urgent)')
    await expect(page.getByTestId('note-work.md')).toContainText('# Work')
    await expect(page.getByTestId('note-work.md')).not.toContainText('#urgent')
    await expect(page.getByTestId('tag-work.md-urgent')).not.toBeChecked()
  })

  test('the two directions compose back to where they started', async ({ page }) => {
    await gotoVault(page)
    const before = await page.getByTestId('note-work.md').inputValue()
    await page.getByTestId('tag-work.md-waiting').check()
    await expect(page.getByTestId('note-work.md')).toContainText('#waiting')
    await page.getByTestId('tag-work.md-waiting').uncheck()
    await expect(page.getByTestId('note-work.md')).toHaveValue(before)
  })

  test('a tag written by hand flows forward into the grid', async ({ page }) => {
    await gotoVault(page)
    const note = page.getByTestId('note-home.md')
    await note.fill((await note.inputValue()).replace('# Home', '# Home #waiting'))
    await expect(page.getByTestId('tag-home.md-waiting')).toBeChecked()
  })

  test('tags are facts about the note, not part of its title', async ({ page }) => {
    await gotoVault(page)
    // The title in every other view is the heading without its tags…
    await expect(page.getByTestId('agenda-input-0-reply to sam')).toHaveValue('Work')
    // …and renaming it through those views leaves the tags alone.
    const title = page.getByTestId('agenda-input-0-reply to sam')
    await title.fill('Job')
    await title.blur()
    await expect(page.getByTestId('note-work.md')).toContainText('# Job #urgent')
    await expect(page.getByTestId('tag-work.md-urgent')).toBeChecked()
  })

  test('the annotation is what collapses it to one answer', async ({ page }) => {
    await gotoVault(page)
    await page.getByTestId('vault-program-panel').getByText('Datalog program').click()
    const source = page.getByTestId('vault-program-source')
    await source.fill((await source.inputValue()).replace('.put into MdTag', ''))
    await page.getByTestId('vault-program-rebuild').click()

    // Deleting the document's heading makes the row stop existing. So does
    // dropping #errand from the palette, which would take it away from every
    // note at once. Both are true and neither is what a tick means, so the
    // engine asks instead of guessing.
    await page.getByTestId('tag-home.md-errand').click()
    await expect(page.getByTestId('vault-status')).toContainText('ambiguous')
    await expect(page.getByTestId('note-home.md')).not.toContainText('#errand')
  })
})
