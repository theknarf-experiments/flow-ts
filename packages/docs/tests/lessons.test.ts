// Every tutorial program, run against its seed facts.
//
// The lessons are documentation, and documentation rots. Each one makes claims
// in prose about rows the reader is about to see — "four people, three ages",
// "58, which is (25 + 4) * 2" — and those claims are only worth making if
// something checks them. So the derived rows are asserted here, and a change to
// the engine that quietly changes an answer fails the build instead of turning
// a lesson into a lie.
//
// It also guards the two structural properties the tutorial rests on: that the
// lessons parse and run at all, and that between them they cover the language.

import { describe, expect, it } from 'vitest'
import { parseProgram } from 'flow-ts'
import { compileShadow, executeProgram, openBackwardSession, type Row } from 'flow-ts'
import { LESSONS, TOP_LEVEL, lessonBySlug, lessonLabel } from '../src/lessons/lessons.js'

/** Run a program and net the diffs into a final row set per relation.
 *
 *  Netting matters: evaluation emits a row as soon as some rule derives it and
 *  retracts it again if a later stratum takes the support away, so a sink that
 *  only counts `diff > 0` sees rows that aren't in the answer. `Orphan` in the
 *  incremental lesson is exactly that shape — negation over a relation that is
 *  still filling in. */
function evaluate(source: string, facts: Readonly<Record<string, readonly Row[]>>, tag: string) {
  const program = parseProgram(source, { grammarSource: `${tag}.dl` })
  const seed = new Map<string, Row[]>(
    Object.entries(facts).map(([rel, rows]) => [rel, rows.map((r) => [...r])]),
  )
  const net = new Map<string, Map<string, number>>()
  executeProgram(program, seed, {}, (rel, row, diff) => {
    let bucket = net.get(rel)
    if (!bucket) net.set(rel, (bucket = new Map()))
    const key = row.join('|')
    bucket.set(key, (bucket.get(key) ?? 0) + diff)
  })
  const out = new Map<string, string[]>()
  for (const [rel, bucket] of net) {
    out.set(
      rel,
      [...bucket].filter(([, n]) => n > 0).map(([key]) => key).sort(),
    )
  }
  return out
}

/** Run a lesson's own program against its own seed facts. */
function derive(slug: string): Map<string, string[]> {
  const lesson = lessonBySlug(slug)
  if (!lesson) throw new Error(`no lesson "${slug}"`)
  return evaluate(lesson.source, lesson.facts, slug)
}

/** Derived rows for one relation, sorted so the comparison is order-free. */
function rows(slug: string, relation: string): string[] {
  return derive(slug).get(relation) ?? []
}

describe('every lesson', () => {
  it.each(LESSONS.map((l) => [l.slug] as const))('%s parses and runs', (slug) => {
    expect(() => derive(slug)).not.toThrow()
  })

  it('declares every EDB it seeds', () => {
    for (const lesson of LESSONS) {
      const program = parseProgram(lesson.source, { grammarSource: `${lesson.slug}.dl` })
      const declared = new Set(program.edbs.map((d) => d.name))
      for (const [rel, seeded] of Object.entries(lesson.facts)) {
        expect(declared, `${lesson.slug}: ${rel}`).toContain(rel)
        const arity = program.edbs.find((d) => d.name === rel)!.arity()
        for (const row of seeded) expect(row.length, `${lesson.slug}: ${rel}`).toBe(arity)
      }
    }
  })

  it('has unique slugs and derives something', () => {
    expect(new Set(LESSONS.map((l) => l.slug)).size).toBe(LESSONS.length)
    for (const lesson of LESSONS) {
      expect(derive(lesson.slug).size, lesson.slug).toBeGreaterThan(0)
    }
  })

  // The tutorial's reason to exist. If the engine grows a feature, it belongs
  // in a lesson, and this list is where that gets noticed — adding to the
  // grammar without adding to a lesson leaves an entry here unmatched.
  it('covers the language', () => {
    const taught = new Set(LESSONS.flatMap((l) => l.teaches))
    for (const feature of [
      '.decl',
      '.in / .out',
      'number / string / float',
      'any',
      ':-',
      'projection',
      'set semantics',
      'equijoin by shared variable',
      'constants in atoms',
      '`_` wildcard',
      '= == != < <= > >=',
      '+ - * / %',
      'head expressions',
      'multiple rules per head',
      'IDBs in rule bodies',
      'recursive rules',
      '!Atom',
      'stratified negation',
      'count()',
      'sum()',
      'min()',
      'max()',
      'implicit group-by',
      'fact retraction',
      '?- query rules',
      '?- bare goals',
      'writable views',
      'writableColumns',
      'Resolution',
      '.put insert defaults(...)',
      '.put insert via R',
      '.put spread(min|max)',
      '.put into R',
      '.put none',
    ]) {
      expect(taught, `no lesson teaches ${feature}`).toContain(feature)
    }
  })
})

describe('facts', () => {
  it('projects names, and collapses the duplicate age', () => {
    expect(rows('facts', 'Name')).toEqual(['alice', 'bob', 'carol', 'dave'])
    // Four people, three ages — bob and dave are both 17.
    expect(rows('facts', 'Age')).toEqual(['17', '29', '34'])
  })

  it("carries both kinds through the `any` column, keeping each cell's type", () => {
    const lesson = lessonBySlug('facts')!
    const seen: Row[] = []
    executeProgram(
      parseProgram(lesson.source, { grammarSource: 'facts.dl' }),
      new Map(Object.entries(lesson.facts).map(([r, rs]) => [r, rs.map((x) => [...x])])),
      {},
      (rel, row, diff) => {
        if (rel === 'Value' && diff > 0) seen.push([...row])
      },
    )
    // Numbers stay numbers rather than being stringified into the column.
    expect(seen.map((r) => r[0]).sort()).toEqual([1991, 1996, 'Bergen', 'Oslo'])
    expect(seen.filter((r) => typeof r[0] === 'number')).toHaveLength(2)
  })
})

describe('joins', () => {
  it('joins on the shared variable', () => {
    expect(rows('joins', 'Owns')).toEqual(['alice|mia', 'alice|rex', 'bob|sam', 'carol|kiwi'])
  })

  it('drops the pet whose species has no vet', () => {
    const clinic = rows('joins', 'Clinic')
    expect(clinic).toEqual([
      'alice|mia|Northside',
      'alice|rex|Northside',
      'alice|rex|Paws & Co',
      'bob|sam|Northside',
      'bob|sam|Paws & Co',
    ])
    expect(clinic.some((r) => r.startsWith('carol'))).toBe(false)
  })
})

describe('filters', () => {
  it('narrows by constant, wildcard and comparison', () => {
    expect(rows('filters', 'DogOwner')).toEqual(['alice'])
    // alice owns two pets and appears once — the wildcards bind nothing.
    expect(rows('filters', 'HasPet')).toEqual(['alice', 'bob'])
    expect(rows('filters', 'Adult')).toEqual(['alice', 'carol'])
  })

  it('holds both directions of every peer pair, and no self-pair', () => {
    expect(rows('filters', 'Peer')).toEqual([
      'alice|carol',
      'bob|dave',
      'carol|alice',
      'dave|bob',
    ])
  })
})

describe('arithmetic', () => {
  it('computes head expressions', () => {
    expect(rows('arithmetic', 'Total')).toEqual(['bolt|300', 'gear|30', 'widget|100'])
    expect(rows('arithmetic', 'Net')).toEqual(['gear|25', 'widget|90'])
  })

  it('truncates division towards zero', () => {
    // 25 / 2 is 12, not 12.5 — there is no true division in the language.
    expect(rows('arithmetic', 'Half')).toEqual(['bolt|1', 'gear|7', 'widget|12'])
  })

  it('evaluates left to right, with no precedence', () => {
    // widget: (25 + 4) * 2 = 58. Ordinary precedence would give 33.
    expect(rows('arithmetic', 'LeftToRight')).toEqual(['bolt|206', 'gear|34', 'widget|58'])
  })

  it('filters on an expression in the body', () => {
    expect(rows('arithmetic', 'Bulk')).toEqual(['bolt'])
  })
})

describe('many-rules', () => {
  it('unions the two rules, once per person', () => {
    // dana is on both lists and appears once.
    expect(rows('many-rules', 'Worker')).toEqual(['alice', 'bob', 'carol', 'dana'])
    expect(rows('many-rules', 'OnSite')).toEqual(['alice', 'carol', 'dana'])
  })
})

describe('recursion', () => {
  it('takes the transitive closure', () => {
    expect(rows('recursion', 'Ancestor')).toEqual([
      'ada|barbara',
      'ada|brendan',
      'ada|chris',
      'ada|cleo',
      'ada|dana',
      'barbara|cleo',
      'brendan|chris',
      'brendan|dana',
      'chris|dana',
    ])
  })

  it('pairs siblings both ways round', () => {
    expect(rows('recursion', 'Sibling')).toEqual(['barbara|brendan', 'brendan|barbara'])
  })
})

describe('negation', () => {
  it('excludes what the negated atom matches', () => {
    expect(rows('negation', 'Visible')).toEqual(['kettle', 'lamp', 'vase'])
  })

  it('bounds the unbound variable with the vocabulary', () => {
    expect(rows('negation', 'Untagged')).toEqual([
      'kettle|fragile',
      'kettle|outdoor',
      'lamp|kitchen',
      'lamp|outdoor',
      'rug|fragile',
      'rug|kitchen',
      'rug|outdoor',
      'vase|kitchen',
      'vase|outdoor',
    ])
  })

  it('negates over a wildcard for "no tag at all"', () => {
    expect(rows('negation', 'Bare')).toEqual(['rug'])
  })
})

describe('aggregation', () => {
  it('groups by the other head columns', () => {
    expect(rows('aggregation', 'Deals')).toEqual(['east|1', 'north|3', 'south|2'])
    expect(rows('aggregation', 'Revenue')).toEqual(['east|45', 'north|400', 'south|400'])
    expect(rows('aggregation', 'Best')).toEqual(['east|45', 'north|200', 'south|340'])
    expect(rows('aggregation', 'Worst')).toEqual(['east|45', 'north|80', 'south|60'])
    expect(rows('aggregation', 'PerRep')).toEqual([
      'east|dave|45',
      'north|alice|200',
      'north|bob|200',
      'south|carol|400',
    ])
  })

  it('aggregates the lot into one row when the head keeps nothing', () => {
    expect(rows('aggregation', 'Overall')).toEqual(['845'])
  })
})

describe('incremental', () => {
  it('reaches everything linked from home', () => {
    expect(rows('incremental', 'FromHome')).toEqual(['api', 'blog', 'docs', 'guide'])
    expect(rows('incremental', 'Orphan')).toEqual(['scratch'])
  })

  it('drops the pages whose only support was retracted', () => {
    // The claim the lesson makes in prose: cutting one of the two paths to
    // `api` changes nothing, cutting both takes `api` and `guide` with it.
    // Asserted here against smaller fact sets rather than by feeding deltas —
    // the delta path is `packages/flow-ts`'s to test, and this is about the
    // answers the reader is told to expect.
    const lesson = lessonBySlug('incremental')!
    const links = lesson.facts.Link!

    const oneCut = links.filter((r) => !(r[0] === 'docs' && r[1] === 'api'))
    expect(evaluate(lesson.source, { Link: oneCut }, 'inc-1').get('FromHome')).toEqual([
      'api',
      'blog',
      'docs',
      'guide',
    ])

    const bothCut = oneCut.filter((r) => !(r[0] === 'blog' && r[1] === 'api'))
    expect(evaluate(lesson.source, { Link: bothCut }, 'inc-2').get('FromHome')).toEqual([
      'blog',
      'docs',
    ])
  })
})

describe('queries', () => {
  it('declares the relations the console example joins', () => {
    expect(rows('queries', 'Headcount')).toEqual(['design|1', 'eng|2', 'ops|2'])
  })
})


// --- writing back ----------------------------------------------------------
//
// Four lessons on one subject, so the harness is shared. Each `.put` policy is
// checked twice: that it does what the lesson says, and that *without* it the
// engine refuses in the way the lesson tells the reader to go and see. The
// second half matters as much as the first — half of what these lessons teach
// is what the refusals mean.

/** A backward session over a lesson, seeded with its facts. */
function backward(slug: string, source?: string) {
  const lesson = lessonBySlug(slug)!
  const program = parseProgram(source ?? lesson.source, { grammarSource: `${slug}.dl` })
  const session = openBackwardSession(program, {
    views: [...lesson.writable!],
    parse: (src) => parseProgram(src, { grammarSource: 'shadow.dl' }),
  })
  for (const [rel, seeded] of Object.entries(lesson.facts)) {
    for (const row of seeded) session.update(rel, [...row], +1)
  }
  session.advance()
  return session
}

/** Which columns of each view the compiler will accept a write through. */
function writableColumns(slug: string, source?: string) {
  const lesson = lessonBySlug(slug)!
  return compileShadow(parseProgram(source ?? lesson.source, { grammarSource: `${slug}.dl` }), {
    views: [...lesson.writable!],
  }).writableColumns
}

/** The lesson's source with one line taken out — how every "delete this line
 *  and rebuild" instruction is checked. */
function without(slug: string, line: string): string {
  const lesson = lessonBySlug(slug)!
  expect(lesson.source, `${slug} has no line "${line}"`).toContain(line)
  return lesson.source.replace(`${line}\n`, '')
}

const changes = (r: ReturnType<ReturnType<typeof backward>['resolve']>) =>
  r.status === 'ok' ? r.changes : []

describe('write-back: the basics', () => {
  it('derives the views a reader is about to edit', () => {
    expect(rows('write-back', 'Roster')).toEqual(['alice|eng', 'bob|eng', 'carol|ops'])
    expect(rows('write-back', 'Headcount')).toEqual(['eng|2', 'ops|1'])
  })

  it('offers both Roster columns and nothing on the aggregate', () => {
    const cols = writableColumns('write-back')
    expect(cols.Roster).toEqual([0, 1])
    expect(cols.Headcount ?? []).toEqual([])
  })

  it('lands a rename on the Employee fact, id and all', () => {
    const r = backward('write-back').resolve(
      { rel: 'Roster', row: ['alice', 'eng'], newRow: ['alicia', 'eng'] },
      { commit: false },
    )
    expect(changes(r)).toEqual([
      { kind: 'upd', rel: 'Employee', row: [1, 'alice', 'eng'], newRow: [1, 'alicia', 'eng'] },
    ])
  })

  it('deletes the supporting fact rather than hiding the row', () => {
    const r = backward('write-back').resolve(
      { rel: 'Roster', row: ['carol', 'ops'] },
      { commit: false, minimize: true },
    )
    expect(changes(r)).toEqual([{ kind: 'del', rel: 'Employee', row: [3, 'carol', 'ops'] }])
  })

  it('refuses an insert, naming the column the view drops', () => {
    const r = backward('write-back').resolve(
      { rel: 'Roster', row: ['erin', 'design'], insert: true },
      { commit: false },
    )
    expect(r.status).toBe('refused')
    expect(r.status === 'refused' && r.reason).toMatch(/"i".*\.put insert defaults/s)
  })

  it('refuses the aggregate, naming the distribution policy', () => {
    const r = backward('write-back').resolve(
      { rel: 'Headcount', row: ['eng', 2], newRow: ['eng', 3] },
      { commit: false },
    )
    expect(r.status).toBe('refused')
    expect(r.status === 'refused' && r.reason).toMatch(/aggregation/)
  })
})

describe('write-back: .put insert', () => {
  it('unions both rules into Worker', () => {
    expect(rows('put-insert', 'Worker')).toEqual(['alice', 'bob', 'carol', 'dana'])
  })

  it('supplies the dropped id from defaults', () => {
    const r = backward('put-insert').resolve(
      { rel: 'Roster', row: ['erin', 'design'], insert: true },
      { commit: false },
    )
    expect(changes(r)).toEqual([{ kind: 'ins', rel: 'Employee', row: [0, 'erin', 'design'] }])
  })

  it('inserts through the rule `via` names, with that rule\'s defaults', () => {
    const r = backward('put-insert').resolve(
      { rel: 'Worker', row: ['erin'], insert: true },
      { commit: false },
    )
    expect(changes(r)).toEqual([
      { kind: 'ins', rel: 'Contractor', row: ['erin', 'unassigned'] },
    ])
  })

  it('needs no annotation to delete through a multi-rule head', () => {
    const r = backward('put-insert').resolve(
      { rel: 'Worker', row: ['dana'] },
      { commit: false, minimize: true },
    )
    expect(changes(r)).toEqual([{ kind: 'del', rel: 'Contractor', row: ['dana', 'Acme'] }])
  })

  it('without `via`, says the head has several rules and asks which', () => {
    const source = without('put-insert', '.put insert via Contractor defaults(a = "unassigned")')
    const r = backward('put-insert', source).resolve(
      { rel: 'Worker', row: ['erin'], insert: true },
      { commit: false },
    )
    expect(r.status).toBe('refused')
    expect(r.status === 'refused' && r.reason).toMatch(/several rules.*\.put insert via/s)
  })
})

describe('write-back: .put spread', () => {
  it('derives the totals the lesson quotes', () => {
    expect(rows('put-spread', 'Booked')).toEqual(['alice|32', 'bob|35', 'carol|16'])
    expect(rows('put-spread', 'Peak')).toEqual(['alice|20', 'bob|35', 'carol|8'])
  })

  it('makes only the sum writable — `max` is not a distribution', () => {
    const cols = writableColumns('put-spread')
    expect(cols.Booked).toEqual([1])
    expect(cols.Peak ?? []).toEqual([])
  })

  it('splits evenly when the member count divides the delta', () => {
    const r = backward('put-spread').resolve(
      { rel: 'Booked', row: ['alice', 32], newRow: ['alice', 40] },
      { commit: false },
    )
    expect(
      changes(r)
        .map((c) => `${c.row.join('|')} → ${c.newRow?.join('|')}`)
        .sort(),
    ).toEqual(['alice|1|12 → alice|1|16', 'alice|2|20 → alice|2|24'])
  })

  it('gives the residual to the lowest member under spread(min)', () => {
    const r = backward('put-spread').resolve(
      { rel: 'Booked', row: ['alice', 32], newRow: ['alice', 33] },
      { commit: false },
    )
    expect(changes(r).filter((c) => c.newRow?.[2] !== c.row[2])).toEqual([
      { kind: 'upd', rel: 'Hours', row: ['alice', 1, 12], newRow: ['alice', 1, 13] },
    ])
  })

  it('and to the highest under spread(max)', () => {
    const source = lessonBySlug('put-spread')!.source.replace('spread(min)', 'spread(max)')
    const r = backward('put-spread', source).resolve(
      { rel: 'Booked', row: ['alice', 32], newRow: ['alice', 33] },
      { commit: false },
    )
    expect(changes(r).filter((c) => c.newRow?.[2] !== c.row[2])).toEqual([
      { kind: 'upd', rel: 'Hours', row: ['alice', 2, 20], newRow: ['alice', 2, 21] },
    ])
  })

  it('without the annotation, the whole view is read-only', () => {
    const source = without('put-spread', '.put spread(min)')
    expect(writableColumns('put-spread', source).Booked ?? []).toEqual([])
  })
})

describe('write-back: .put into and .put none', () => {
  it('derives the join', () => {
    expect(rows('put-into', 'WhoLeads')).toEqual([
      'alice|frida',
      'bob|frida',
      'carol|gus',
    ])
  })

  it('holds Team constant, so only the Employee column is writable', () => {
    expect(writableColumns('put-into').WhoLeads).toEqual([0])
  })

  it('sends a delete to the side the annotation names', () => {
    const r = backward('put-into').resolve(
      { rel: 'WhoLeads', row: ['alice', 'frida'] },
      { commit: false, requireUnambiguous: true },
    )
    expect(changes(r)).toEqual([{ kind: 'del', rel: 'Employee', row: [1, 'alice', 'eng'] }])
  })

  it('without it, both columns are writable and a delete is ambiguous', () => {
    const source = without('put-into', '.put into Employee')
    expect(writableColumns('put-into', source).WhoLeads).toEqual([0, 1])

    const r = backward('put-into', source).resolve(
      { rel: 'WhoLeads', row: ['alice', 'frida'] },
      { commit: false, requireUnambiguous: true },
    )
    expect(r.status).toBe('ambiguous')
    expect(r.status === 'ambiguous' && r.candidates.map((c) => c.rel).sort()).toEqual([
      'Employee',
      'Team',
    ])
  })

  it('without it, renaming a lead rewrites the Team fact', () => {
    const source = without('put-into', '.put into Employee')
    const r = backward('put-into', source).resolve(
      { rel: 'WhoLeads', row: ['alice', 'frida'], newRow: ['alice', 'freda'] },
      { commit: false },
    )
    expect(changes(r)).toEqual([
      { kind: 'upd', rel: 'Team', row: ['eng', 'frida'], newRow: ['eng', 'freda'] },
    ])
  })

  it('refuses the read-only view by quoting the annotation', () => {
    const r = backward('put-into').resolve(
      { rel: 'Headcount', row: ['eng', 2], newRow: ['eng', 3] },
      { commit: false },
    )
    expect(r.status).toBe('refused')
    expect(r.status === 'refused' && r.reason).toMatch(/\.put none/)
  })

  it('and without it, refuses for a reason that reads like an omission', () => {
    const source = without('put-into', '.put none')
    const r = backward('put-into', source).resolve(
      { rel: 'Headcount', row: ['eng', 2], newRow: ['eng', 3] },
      { commit: false },
    )
    expect(r.status).toBe('refused')
    expect(r.status === 'refused' && r.reason).toMatch(/aggregation/)
  })
})

describe('the tutorial outline', () => {
  it('nests only one level, under a lesson that exists', () => {
    for (const lesson of LESSONS) {
      if (!lesson.subOf) continue
      const parent = lessonBySlug(lesson.subOf)
      expect(parent, `${lesson.slug} refines a missing lesson`).toBeDefined()
      expect(parent!.subOf, `${lesson.slug} nests two levels deep`).toBeUndefined()
    }
  })

  it('keeps sub-lessons next to what they refine', () => {
    // A sub-lesson that isn't adjacent to its parent would be numbered out of
    // the order the sidebar renders it in.
    for (const lesson of LESSONS) {
      if (!lesson.subOf) continue
      const previous = LESSONS[LESSONS.indexOf(lesson) - 1]
      expect(previous, lesson.slug).toBeDefined()
      expect(
        previous!.slug === lesson.subOf || previous!.subOf === lesson.subOf,
        `${lesson.slug} is separated from ${lesson.subOf}`,
      ).toBe(true)
    }
  })
})

describe('step numbering', () => {
  it('numbers the tutorial proper 1..n, refinements excluded', () => {
    expect(TOP_LEVEL.map(lessonLabel)).toEqual(
      TOP_LEVEL.map((_, i) => String(i + 1)),
    )
    // The four write-back lessons collapse to one step with three parts.
    expect(TOP_LEVEL.length).toBe(LESSONS.length - 3)
  })

  it('numbers a refinement within its parent', () => {
    expect(LESSONS.filter((l) => l.subOf).map(lessonLabel)).toEqual([
      '11.1',
      '11.2',
      '11.3',
    ])
    expect(lessonLabel(lessonBySlug('write-back')!)).toBe('11')
  })

  it('gives every lesson a distinct label', () => {
    const labels = LESSONS.map(lessonLabel)
    expect(new Set(labels).size).toBe(labels.length)
  })
})
