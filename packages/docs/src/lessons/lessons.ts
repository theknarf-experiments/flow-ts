// The tutorial, as data.
//
// One entry per feature of the language, ordered so that each lesson only uses
// what the ones before it introduced. Everything a lesson needs to render — the
// prose, the program, the seed facts, the things worth trying — is here, and
// `Lesson.tsx` is the single component that renders all of them. Adding a
// lesson is adding an entry to this array; there is no per-lesson component to
// write and no route to register.
//
// The programs are deliberately tiny. A lesson that needs a paragraph of
// scene-setting before the rules make sense is a lesson about the scenario
// rather than about the engine, and the four demos in the sidebar are where
// that belongs.
//
// Every program here is executed against its seed facts by
// `tests/lessons.test.ts`, which asserts the derived rows the prose claims. A
// lesson that stops being true fails the build rather than quietly misleading
// somebody.

import type { WriteOptions } from '@flow-ts/react'
import type { Row } from 'flow-ts'

/** The ad-hoc query console, for the one lesson that teaches it. */
export interface LessonConsole {
  /** Pre-filled source, so the console has something to show on arrival. */
  initial: string
  /** One line under the editor. */
  hint: string
}

export interface Lesson {
  /** URL segment under `/learn`. */
  slug: string
  title: string
  /** Slug of the lesson this one refines, if any.
   *
   *  One level, and only one. The four write-back lessons are all the same
   *  subject — an edit to a derived row — differing in which `.put` policy
   *  supplies the part the rules leave open, and listing them flat would make
   *  the tutorial look like it spends a third of its length on annotations
   *  rather than one step with three refinements. They are still numbered in
   *  sequence, because they are still steps. */
  subOf?: string
  /** One line, shown in the sidebar and on the overview page. */
  blurb: string
  /** The language features this lesson is the documentation for. Rendered as
   *  chips, and the reason the tutorial can claim coverage: the union of these
   *  across all lessons is checked against a hand-maintained list in
   *  `tests/lessons.test.ts`. */
  teaches: readonly string[]
  /** Paragraphs above the program. Backticks mark inline code. */
  intro: readonly string[]
  /** The Datalog. */
  source: string
  /** Seed rows per EDB. */
  facts: Readonly<Record<string, readonly Row[]>>
  /** Experiments, rendered as a list under the tables. */
  tryThis: readonly string[]
  /** Paragraphs below the tables — caveats, sharp edges, the small print. */
  notes?: readonly string[]
  /** Views to open for writing. Their tables render editable. */
  writable?: readonly string[]
  /** Knobs for the writes this lesson's tables make.
   *
   *  `requireUnambiguous` is the one that matters for teaching: a request that
   *  reaches two source relations is reported rather than resolved by picking,
   *  which is what makes the difference an annotation buys visible on screen
   *  instead of only in the prose. */
  writeOptions?: WriteOptions
  /** Show the ad-hoc query console. */
  console?: LessonConsole
}

export const LESSONS: readonly Lesson[] = [
  // ---------------------------------------------------------------- 1
  {
    slug: 'facts',
    title: 'Facts and rules',
    blurb: 'Relations, tuples, and the first rule.',
    teaches: [
      '.decl',
      '.in / .out',
      'number / string / float',
      'any',
      ':-',
      'projection',
      'set semantics',
    ],
    intro: [
      'A Datalog database is a set of relations, and a relation is a set of rows. `.decl Person(name: string, age: number, height: float)` declares one: a name, three columns, one type each. `number` is an integer, `float` is a decimal, `string` is text.',
      'There is a fourth, `any`, for a column whose shape is the data\'s business rather than the program\'s. `Note(subject, field, value)` below is a property bag: a birth year is a number, a city is a string, and both belong in the same column. An `any` cell keeps whichever it is — it is not a string that everything gets converted to.',
      'Relations come in two kinds. Under `.in` are the ones you put facts into — the *extensional* database, or EDB. Under `.out` are the ones the engine computes — the *intensional* database, or IDB. You can only edit the first kind; the second is whatever the rules say it is.',
      'A rule reads right-to-left. `Name(n) :- Person(n, a, h).` says: for every row of `Person`, bind its three columns to `n`, `a` and `h`, then put a row into `Name` holding just `n`. Variables are positional — the name you choose means nothing, only where it sits.',
      'The head keeps `n` and drops `a` and `h`, which is a projection. And because relations are *sets*, projecting away a column collapses the rows that only differed there: four people, but `Age` below has three rows, because two of them are 17.',
    ],
    source: `.in
.decl Person(name: string, age: number, height: float)
.decl Note(subject: string, field: string, value: any)

.out
.decl Name(name: string)
.decl Age(age: number)
.decl Value(v: any)

Name(n) :- Person(n, a, h).
Age(a) :- Person(n, a, h).
Value(v) :- Note(s, f, v).
`,
    facts: {
      Person: [
        ['alice', 34, 1.62],
        ['bob', 17, 1.78],
        ['carol', 29, 1.55],
        ['dave', 17, 1.91],
      ],
      Note: [
        ['alice', 'born', 1991],
        ['alice', 'city', 'Oslo'],
        ['bob', 'city', 'Bergen'],
        ['carol', 'born', 1996],
      ],
    },
    tryThis: [
      'Add a fifth person aged 29 in the `Person` table. `Name` grows by a row; `Age` does not.',
      'Delete `bob`. `Age` keeps 17, because dave is still 17.',
      'In the program, change `Name(n)` to `Name(h)` and rebuild. It fails: `Name` is declared `string` and `h` is a `float`.',
      'Add a `Note` row with a number in `value` and another with a word. Both land in `Value` — one relation, both kinds.',
      'Change `.decl Value(v: any)` to `.decl Value(v: string)` and rebuild. Now the rule is inconsistent with the declaration, and it says so.',
      'Add `.decl Tall(name: string)` under `.out` and the rule `Tall(n) :- Person(n, a, h).`, then rebuild. A new table appears — the inspector is driven by the program, not hard-coded.',
    ],
    notes: [
      'Editing the program rebuilds the dataflow graph from scratch, but your facts survive: the store replays every EDB row into the new graph. So you can iterate on rules without re-typing your data.',
      '`any` is a declaration about a *column*, not a change to what a cell can be — a cell is still a number or a string. And it is for when you genuinely do not know: a column read from a file as `any` reads `007` as the number 7, because inferring from text is the only thing it can do. If you know the column is text, `string` says so and keeps the zeros.',
    ],
  },

  // ---------------------------------------------------------------- 2
  {
    slug: 'joins',
    title: 'Joins',
    blurb: 'One variable in two places is a join.',
    teaches: ['multi-atom bodies', 'equijoin by shared variable', 'n-way joins'],
    intro: [
      'Put two atoms in a body and you get a join. There is no `JOIN` keyword and no `ON` clause — the join is the fact that `i` appears in both `Person(i, n)` and `Pet(i, p, s)`. A row is derived once for every pair that agrees on `i`.',
      '`Clinic` extends that to three atoms: person to pet by owner id, pet to vet by species. Any number of atoms works, and the planner decides what order to actually evaluate them in.',
      'Joins drop what does not match. carol owns a parrot, no vet in the table treats parrots, so carol appears in `Owns` and not in `Clinic`. There is no outer join in Datalog; if you want the unmatched rows you write a second rule for them.',
    ],
    source: `.in
.decl Person(id: number, name: string)
.decl Pet(owner: number, pet: string, species: string)
.decl Vet(species: string, clinic: string)

.out
.decl Owns(name: string, pet: string)
.decl Clinic(name: string, pet: string, clinic: string)

Owns(n, p) :- Person(i, n), Pet(i, p, s).
Clinic(n, p, c) :- Person(i, n), Pet(i, p, s), Vet(s, c).
`,
    facts: {
      Person: [
        [1, 'alice'],
        [2, 'bob'],
        [3, 'carol'],
      ],
      Pet: [
        [1, 'rex', 'dog'],
        [1, 'mia', 'cat'],
        [2, 'sam', 'dog'],
        [3, 'kiwi', 'parrot'],
      ],
      Vet: [
        ['dog', 'Northside'],
        ['cat', 'Northside'],
        ['dog', 'Paws & Co'],
      ],
    },
    tryThis: [
      'Add `("parrot", "Featherworks")` to `Vet`. carol appears in `Clinic` immediately.',
      "Notice rex has two clinic rows and mia has one — a join multiplies, it doesn't pick.",
      'Delete the `Person` row for alice. Both her pets vanish from `Owns` and `Clinic` at once.',
      'Change `Clinic` to `Clinic(n, p, c) :- Person(i, n), Pet(j, p, s), Vet(s, c).` and rebuild. `i` and `j` are different variables, so nothing constrains owner to person: every person is now paired with every pet.',
    ],
  },

  // ---------------------------------------------------------------- 3
  {
    slug: 'filters',
    title: 'Filters',
    blurb: 'Constants, wildcards, and comparisons.',
    teaches: ['constants in atoms', '`_` wildcard', '= == != < <= > >=', 'self-joins'],
    intro: [
      'Three ways to narrow a rule, all in the body.',
      'A **constant** in an atom position matches only that value. `Pet(i, p, "dog")` is the same as writing `Pet(i, p, s), s = "dog"`, and reads better.',
      'A **wildcard** `_` matches anything and binds nothing. `Pet(i, _, _)` asks only whether person `i` owns something at all; use it wherever you would otherwise invent a variable and never mention it again.',
      'A **comparison** is a body predicate rather than an atom: `=`, `==`, `!=`, `<`, `<=`, `>`, `>=`. It filters over variables that are already bound by the atoms — it cannot introduce one. `Peer` uses `!=` to keep a self-join from pairing everybody with themselves.',
    ],
    source: `.in
.decl Person(id: number, name: string, age: number)
.decl Pet(owner: number, pet: string, species: string)

.out
.decl DogOwner(name: string)
.decl HasPet(name: string)
.decl Adult(name: string)
.decl Peer(a: string, b: string)

DogOwner(n) :- Person(i, n, g), Pet(i, p, "dog").
HasPet(n) :- Person(i, n, g), Pet(i, _, _).
Adult(n) :- Person(i, n, g), g >= 18.
Peer(a, b) :- Person(i, a, g), Person(j, b, g), i != j.
`,
    facts: {
      Person: [
        [1, 'alice', 34],
        [2, 'bob', 17],
        [3, 'carol', 34],
        [4, 'dave', 17],
      ],
      Pet: [
        [1, 'rex', 'dog'],
        [1, 'mia', 'cat'],
        [2, 'sam', 'cat'],
      ],
    },
    tryThis: [
      "Note `HasPet` lists alice once, not twice, even though she owns two pets — the wildcards bind nothing, so both derivations produce the same row and a relation is a set.",
      'Change `g >= 18` to `g > 18` and rebuild. Nothing changes here; now set alice\'s age to 18 and it does.',
      'Add a third 34-year-old. `Peer` grows by four rows, not two — it holds both directions of every pair.',
      'Try `Adult(n) :- Person(i, n, g), h >= 18.` and rebuild. It is rejected: `h` is bound by nothing, and a comparison cannot bind it.',
    ],
    notes: [
      '`=` and `==` mean the same thing. Neither is assignment: there is no way to introduce a new value in the body, which is why computed columns live in the head — the next lesson.',
    ],
  },

  // ---------------------------------------------------------------- 4
  {
    slug: 'arithmetic',
    title: 'Arithmetic',
    blurb: 'Computing new values in the head.',
    teaches: ['+ - * / %', 'head expressions', 'arithmetic in comparisons', 'int / float mixing'],
    intro: [
      'The body can only filter, so anything computed goes in the **head**: `Total(s, p * q) :- Item(s, p, q).` derives one `Total` row per `Item` row, with the second column worked out rather than copied.',
      'The five operators are `+`, `-`, `*`, `/` and `%`. Expressions may also appear on either side of a body comparison, where they filter rather than derive.',
      'Two things about the arithmetic are worth knowing before you rely on it, and both are visible in the table below. It is **flat and left-to-right, with no operator precedence and no parentheses**: `p + q * 2` means `(p + q) * 2`. And `/` **truncates towards zero**, on `float` columns as much as on `number` ones — there is no true division in the language.',
    ],
    source: `.in
.decl Item(sku: string, price: number, qty: number)
.decl Discount(sku: string, off: number)

.out
.decl Total(sku: string, total: number)
.decl Net(sku: string, net: number)
.decl Half(sku: string, half: number)
.decl LeftToRight(sku: string, v: number)
.decl Bulk(sku: string)

Total(s, p * q) :- Item(s, p, q).
Net(s, p * q - d) :- Item(s, p, q), Discount(s, d).
Half(s, p / 2) :- Item(s, p, q).
LeftToRight(s, p + q * 2) :- Item(s, p, q).
Bulk(s) :- Item(s, p, q), p * q > 200.
`,
    facts: {
      Item: [
        ['widget', 25, 4],
        ['bolt', 3, 100],
        ['gear', 15, 2],
      ],
      Discount: [
        ['widget', 10],
        ['gear', 5],
      ],
    },
    tryThis: [
      'Read `Half` for widget: 25 / 2 is 12, not 12.5. Change the column to `float` and rebuild — still 12.',
      'Read `LeftToRight` for widget: 58, which is `(25 + 4) * 2`. Ordinary precedence would give 33.',
      'Add a `Discount` row for bolt. `Net` gains a row; `Total` already had one, because `Total` never joined `Discount`.',
      'Try `Net(s, p * q - d / 2) :- ...` and work out what it computes before you rebuild. (`((p * q) - d) / 2`.)',
    ],
    notes: [
      'Multi-step expressions that need a different order thread through a helper relation, one operation per rule. That is a real constraint of the language rather than a gap in the parser, and the write-back lesson later on is why: an expression the engine can invert is one it can push an edit back through.',
      'A `float` and a `number` mix freely in one expression; the result is whatever JavaScript arithmetic gives, and the declared type of the head column is what it is stored as.',
    ],
  },

  // ---------------------------------------------------------------- 5
  {
    slug: 'many-rules',
    title: 'Many rules, one relation',
    blurb: 'Union, and rules that build on rules.',
    teaches: ['multiple rules per head', 'union / disjunction', 'IDBs in rule bodies'],
    intro: [
      'A body is a conjunction — every atom must match. To say *or*, write a second rule with the same head. `Worker` has two, so it holds the union: everyone who is an employee, plus everyone who is a contractor.',
      'Because a relation is a set, someone derived by both rules still appears once. dana is on the books twice below and shows up in `Worker` once.',
      'Rule bodies can name IDBs, not just EDBs. `OnSite(n) :- Worker(n), Badge(n).` reads `Worker`, which is itself derived — so rules compose into layers, and the engine works out the order to evaluate them in. You never write that order down.',
    ],
    source: `.in
.decl Employee(name: string, dept: string)
.decl Contractor(name: string, agency: string)
.decl Badge(name: string)

.out
.decl Worker(name: string)
.decl OnSite(name: string)

Worker(n) :- Employee(n, d).
Worker(n) :- Contractor(n, a).
OnSite(n) :- Worker(n), Badge(n).
`,
    facts: {
      Employee: [
        ['alice', 'eng'],
        ['bob', 'ops'],
        ['dana', 'eng'],
      ],
      Contractor: [
        ['carol', 'Acme'],
        ['dana', 'Acme'],
      ],
      Badge: [['alice'], ['carol'], ['dana']],
    },
    tryThis: [
      'Delete dana from `Employee`. She stays in `Worker` — the contractor rule still derives her.',
      'Delete her from `Contractor` too. Now she leaves `Worker`, and `OnSite` with it.',
      'Add a third rule `Worker(n) :- Badge(n).` and rebuild. Anyone with a badge counts, whether or not they are on either list.',
      'Add `.decl Visitor(name: string)` under `.out` with `Visitor(n) :- Badge(n).`, then make `OnSite` read `Visitor` instead of `Badge`. Layers of derived relations cost nothing to declare.',
    ],
  },

  // ---------------------------------------------------------------- 6
  {
    slug: 'recursion',
    title: 'Recursion',
    blurb: 'Rules that read the relation they define.',
    teaches: ['recursive rules', 'transitive closure', 'fixpoint evaluation'],
    intro: [
      'This is the thing Datalog has that SQL had to grow a special form for. `Ancestor` appears in its own body:',
      'The first rule seeds it — a parent is an ancestor. The second extends it — an ancestor of `x`, plus a parent edge out of `x`, gives an ancestor of the child. The engine runs the pair until nothing new comes out, which is called reaching a *fixpoint*, and the result is the transitive closure of `Parent`.',
      'There is no depth limit and no recursion counter, because there is nothing to count: the fixpoint is reached when a round derives no row that was not already there. Cycles in the data are fine — they just stop producing new rows.',
    ],
    source: `.in
.decl Parent(parent: string, child: string)

.out
.decl Ancestor(ancestor: string, descendant: string)
.decl Sibling(a: string, b: string)

Ancestor(p, c) :- Parent(p, c).
Ancestor(a, d) :- Ancestor(a, x), Parent(x, d).
Sibling(a, b) :- Parent(p, a), Parent(p, b), a != b.
`,
    facts: {
      Parent: [
        ['ada', 'brendan'],
        ['ada', 'barbara'],
        ['brendan', 'chris'],
        ['barbara', 'cleo'],
        ['chris', 'dana'],
      ],
    },
    tryThis: [
      'Add `("dana", "ada")` to `Parent` — a cycle. Everyone becomes an ancestor of everyone in the loop, and the evaluation still terminates.',
      'Delete that row again and watch the derived rows disappear. Retraction under recursion is the hard case; the next lesson but two is about it.',
      'Add a great-grandchild. `Ancestor` gains one row per generation above them, all in one step.',
      'Swap the second rule for `Ancestor(a, d) :- Parent(a, x), Ancestor(x, d).` and rebuild. Same answer, different evaluation — this is right-recursion rather than left.',
    ],
    notes: [
      'The engine groups mutually recursive rules into a *stratum* and evaluates the strata in dependency order. `flow-ts inspect program.dl` on the command line prints the strata and the plan, which is the tool to reach for when a rule is not firing when you expect it to.',
    ],
  },

  // ---------------------------------------------------------------- 7
  {
    slug: 'negation',
    title: 'Negation',
    blurb: 'Deriving from the absence of a fact.',
    teaches: ['!Atom', 'safety (range restriction)', 'stratified negation'],
    intro: [
      'Prefix an atom with `!` and it holds when the atom does *not* match. `Visible(i) :- Item(i), !Hidden(i).` — everything on the item list that is not on the hidden list.',
      'Negation carries one rule you have to obey. Every variable in a negated atom must also be bound by a positive atom in the same body, so that "does not match" is asked about specific values rather than about everything in the universe. That is why `Untagged` has a `Vocab(t)` atom: without it, `t` would be unbound and `!Tag(i, t)` would be asking about every string there is.',
      'Negation also constrains evaluation order. `Visible` cannot be computed until `Hidden` is finished, so the engine puts them in different strata and does the second after the first. Rules that make that impossible — where a relation ends up negating itself around a cycle — are rejected at build time rather than looping.',
    ],
    source: `.in
.decl Item(item: string)
.decl Hidden(item: string)
.decl Tag(item: string, tag: string)
.decl Vocab(tag: string)

.out
.decl Visible(item: string)
.decl Untagged(item: string, tag: string)
.decl Bare(item: string)

Visible(i) :- Item(i), !Hidden(i).
Untagged(i, t) :- Item(i), Vocab(t), !Tag(i, t).
Bare(i) :- Item(i), !Tag(i, _).
`,
    facts: {
      Item: [['kettle'], ['lamp'], ['rug'], ['vase']],
      Hidden: [['rug']],
      Tag: [
        ['kettle', 'kitchen'],
        ['lamp', 'fragile'],
        ['vase', 'fragile'],
      ],
      Vocab: [['kitchen'], ['fragile'], ['outdoor']],
    },
    tryThis: [
      'Add `("lamp")` to `Hidden`. It leaves `Visible` — adding a fact took a row away, which is what makes negation non-monotonic.',
      'Add `("rug", "outdoor")` to `Tag`. `Bare` loses rug even though rug is hidden: the two rules are independent.',
      'Add a fourth word to `Vocab`. `Untagged` grows by roughly one row per item — the vocabulary is what bounds the question.',
      'Delete every `Vocab` row. `Untagged` empties out, because there is no longer a tag to ask about.',
    ],
    notes: [
      '`!Tag(i, _)` in `Bare` is negation over a wildcard: "no tag at all". The wildcard binds nothing, so the safety rule is satisfied by `Item(i)` alone.',
    ],
  },

  // ---------------------------------------------------------------- 8
  {
    slug: 'aggregation',
    title: 'Aggregation',
    blurb: 'count, sum, min and max.',
    teaches: ['count()', 'sum()', 'min()', 'max()', 'implicit group-by'],
    intro: [
      'Four aggregates, written in the head: `count`, `sum`, `min` and `max`. `Revenue(r, sum(a)) :- Sale(r, p, a).` sums the amounts.',
      'There is no `GROUP BY` clause. The group key is **the other head columns** — `Revenue` keeps `r`, so it sums per region. `Overall` keeps nothing, so it sums the lot into a single row. Changing what you group by is changing what the head carries.',
      'The aggregate is over the rows the body produces, so a body that joins is aggregating the join. `PerRep` counts distinct region/rep pairs by grouping on both.',
    ],
    source: `.in
.decl Sale(region: string, rep: string, amount: number)

.out
.decl Deals(region: string, n: number)
.decl Revenue(region: string, total: number)
.decl Best(region: string, amount: number)
.decl Worst(region: string, amount: number)
.decl PerRep(region: string, rep: string, total: number)
.decl Overall(total: number)

Deals(r, count(a)) :- Sale(r, p, a).
Revenue(r, sum(a)) :- Sale(r, p, a).
Best(r, max(a)) :- Sale(r, p, a).
Worst(r, min(a)) :- Sale(r, p, a).
PerRep(r, p, sum(a)) :- Sale(r, p, a).
Overall(sum(a)) :- Sale(r, p, a).
`,
    facts: {
      Sale: [
        ['north', 'alice', 120],
        ['north', 'alice', 80],
        ['north', 'bob', 200],
        ['south', 'carol', 60],
        ['south', 'carol', 340],
        ['east', 'dave', 45],
      ],
    },
    tryThis: [
      'Add a sale of 500 in `north`. Every aggregate over north moves in the same tick, and nothing about south is recomputed.',
      'Delete the 340 sale. `Best` for south drops back to 60 — an aggregate has to be able to go down as well as up.',
      'Add `("north", "alice", 80)` a second time. Nothing changes: identical rows are the same row, so `count` counts distinct rows rather than events. Give each sale an id column if you need to count duplicates.',
      'Change `Deals(r, count(a))` to `Deals(r, count(p))` and rebuild. Same answer — `count` counts rows, not distinct values of its argument.',
    ],
    notes: [
      'Aggregation, like negation, is stratified: a relation defined by an aggregate over another has to wait for it to settle. Aggregating a relation that is still recursing is the one place where this engine and the Rust FlowLog it ports differ.',
    ],
  },

  // ---------------------------------------------------------------- 9
  {
    slug: 'incremental',
    title: 'Incremental updates',
    blurb: 'Retraction, and what makes this engine different.',
    teaches: ['fact retraction', 'incremental maintenance', 'non-monotonic fallout'],
    intro: [
      'Everything so far would work in a batch engine. This is the part that does not.',
      'The rules below are the transitive closure from the recursion lesson, over web pages. Delete a link and the pages that were only reachable through it have to leave `Reach` — which means the engine has to know not just what a row derived, but whether anything *else* still derives it.',
      'It does that without re-running the program. The dataflow graph is built once; a fact you add or remove enters as a signed delta and only the operators downstream of it do any work. Adding an edge to a 10,000-row graph costs what that edge changes, not what the graph contains.',
      'The tables below are live views over that graph. Every edit you make in `Link` is one tick: a delta in, a delta out, no re-evaluation.',
    ],
    source: `.in
.decl Link(from: string, to: string)

.out
.decl Reach(from: string, to: string)
.decl FromHome(page: string)
.decl Orphan(page: string)

Reach(a, b) :- Link(a, b).
Reach(a, c) :- Reach(a, b), Link(b, c).
FromHome(p) :- Reach("home", p).
Orphan(p) :- Link(p, q), p != "home", !Reach("home", p).
`,
    facts: {
      Link: [
        ['home', 'docs'],
        ['docs', 'api'],
        ['api', 'guide'],
        ['home', 'blog'],
        ['blog', 'api'],
        ['scratch', 'notes'],
      ],
    },
    tryThis: [
      'Delete `("docs", "api")`. `api` and `guide` stay in `FromHome` — the blog still reaches them.',
      'Now delete `("blog", "api")` as well. Both fall out at once, along with every `Reach` row that went through them.',
      'Put `("docs", "api")` back. They return, and so do the `Reach` rows — retraction and re-derivation are the same machinery run with opposite signs.',
      'Add `("home", "scratch")`. `scratch` and `notes` join `FromHome` and `scratch` leaves `Orphan` in the same tick.',
    ],
    notes: [
      'Outside the browser this is the `--stream` mode of the CLI and the `openSession` API: push `+`/`-` fact deltas over a long-lived session, read the derived deltas back out. The `Store` these pages are built on is a thin wrapper over exactly that.',
    ],
  },

  // ---------------------------------------------------------------- 10
  {
    slug: 'queries',
    title: 'Ad-hoc queries',
    blurb: 'Asking something the program never declared.',
    teaches: ['?- query rules', '?- bare goals', 'one-off evaluation', 'useAdHocQuery'],
    intro: [
      'The relations above are all declared up front, compiled into the graph, and maintained incrementally. That is the right trade for a view something is watching — and the wrong one for a question you just thought of, because splicing a scratch rule into the live program rebuilds the whole graph and makes your question everybody else\'s problem.',
      'So there is a second path. Type a program into the console below and it is evaluated in a throwaway session over the facts this store currently holds. The source relations are already in scope; you write rules on top of them.',
      'A question you are about to throw away should not need a schema, so a rule can bring its own. `?- Payroll(d, sum(s)) :- ...` declares `Payroll` as it defines it — no `.out`, no `.decl`, no column types. The types are recovered from the body when something needs them, which is the same machinery that lets `.decl Foo()` leave its schema to the rules.',
      'Drop the head as well and you have Prolog\'s bare goal: `?- Person(i, n, d), Salary(i, s), s > 100.` reports the variables its body binds, in the order they first appear. It still needs a relation to land in, so one is named for you — `Query1`, `Query2` — which is the right answer for a name nothing outlives.',
      'A goal reports *every* variable it binds, `i` included: a join key has to be named to join, so it comes back with the rest. `_` drops a column nothing needs, but it cannot drop one doing work. When you want to choose the columns, name the head — that is what the rule form is for.',
      'It is sugar and nothing more: `?-` desugars to an empty declaration plus a rule, so a query is an ordinary relation from the moment it parses. Give two `?-` rules the same head and you have written a union; write one in a `.dl` file and the CLI prints it like any other output.',
      'The evaluation is a batch run, priced like one, and it re-runs whenever the facts change. Fine for a console somebody is looking at, wrong for anything on a hot path — which is what the declared, incrementally-maintained views are for.',
    ],
    source: `.in
.decl Person(id: number, name: string, dept: string)
.decl Salary(id: number, amount: number)
.decl Reports(manager: number, report: number)

.out
.decl Headcount(dept: string, n: number)

Headcount(d, count(i)) :- Person(i, n, d).
`,
    facts: {
      Person: [
        [1, 'alice', 'eng'],
        [2, 'bob', 'eng'],
        [3, 'carol', 'ops'],
        [4, 'dave', 'ops'],
        [5, 'erin', 'design'],
      ],
      Salary: [
        [1, 140],
        [2, 120],
        [3, 95],
        [4, 105],
        [5, 110],
      ],
      Reports: [
        [1, 2],
        [1, 5],
        [3, 4],
      ],
    },
    console: {
      initial: `?- Payroll(d, sum(s)) :- Person(i, n, d), Salary(i, s).
`,
      hint: 'The relations above are already in scope. Start a line with `?-` and write a rule.',
    },
    tryThis: [
      'Run the query as it stands, then edit a `Salary` row. The console re-runs.',
      'Ask who manages whom: `?- Chain(mn, rn) :- Reports(m, r), Person(m, mn, dm), Person(r, rn, dr).`',
      'Add a second `?- Chain(...)` rule making it recursive — a manager\'s reports\' reports are theirs too. Two rules, one head, and a one-off query gets the full language.',
      'Drop the head entirely: `?- Person(i, n, d), Salary(i, s).` shows every variable it binds, under a made-up name.',
      'Narrow a single-atom goal with `_`: `?- Person(_, n, d).` reports just the two columns you left named.',
      'Try to drop the join key the same way — `?- Person(_, n, d), Salary(_, s).` — and note the row count explodes. Two `_` are two different anonymous variables, so nothing joins them.',
      'Write the long form instead — `.out`, a `.decl` with column types, then the rule — and get the same answer. `?-` is shorthand for exactly that.',
      'Write something that does not parse. The error shows up under the editor instead of being thrown; a console\'s normal state is half-written.',
    ],
    notes: [
      'The console reads the store\'s own relations rather than re-deriving the facts from wherever they were loaded from, so it can see rows that were put in directly and never came from a file.',
      'A bare goal has to bind at least one variable, since the columns *are* the variables. `?- Person(1, "alice", "eng").` is a yes/no question with nothing to show, and it is refused by saying so rather than answering with an empty row.',
      'The generated name gives way to a real one: if the program already has a relation called `Query1`, the goal becomes `Query2`. A throwaway should never shadow something that isn\'t.',
    ],
  },

  // ---------------------------------------------------------------- 11
  {
    slug: 'write-back',
    title: 'Writing back',
    blurb: 'Editing a derived row and having it land on a fact.',
    teaches: ['writable views', 'writableColumns', 'Resolution'],
    intro: [
      'Everything so far ran one way: facts in, derived rows out. This runs the other way. The `Roster` table below is derived, and editable — change a name in it and the engine works out which `Employee` fact it was copied from and rewrites *that*.',
      'It does this by compiling a second Datalog program from the first. The inverse of a rule is itself a conjunctive query: join the request onto the original body and project onto one body atom. So the backward direction is more rules, maintained incrementally like everything else, and nothing about it is hand-written per relation.',
      'Replaying the body is also what recovers what the view dropped. `Roster` has no `id` column, but the row it came from does, so rewriting a name finds the right `Employee` fact rather than guessing.',
      'Two things are worth watching. Which columns are editable is the compiler\'s answer, not this page\'s — `writableColumns` says which head columns trace back to a single source position, and the rest render read-only. And every edit returns a `Resolution` rather than throwing: `ok` with the facts it changed, or `ambiguous` / `unsatisfied` / `refused` with a reason. The line under each table is that resolution, verbatim.',
      'Not everything can be worked out from the rules alone, and the engine says so rather than guessing. Adding a `Roster` row and editing `Headcount` are both refused below, each naming what it would need. The next three lessons are those answers.',
    ],
    source: `.in
.decl Employee(id: number, name: string, dept: string)

.out
.decl Roster(name: string, dept: string)
.decl Headcount(dept: string, n: number)

Roster(n, d) :- Employee(i, n, d).
Headcount(d, count(n)) :- Roster(n, d).
`,
    facts: {
      Employee: [
        [1, 'alice', 'eng'],
        [2, 'bob', 'eng'],
        [3, 'carol', 'ops'],
      ],
    },
    writable: ['Roster', 'Headcount'],
    tryThis: [
      'Rename alice in `Roster`, then look at `Employee` below: the write landed on the fact, id and all.',
      'Move bob to `ops`. `Headcount` follows, because it is derived from `Roster`, which is derived from the fact that changed.',
      'Remove a `Roster` row. The engine deletes the `Employee` fact behind it rather than hiding the row.',
      'Try to add a row to `Roster`. Refused — and the reason names `i`, the column the view drops and an insert has no row to recover.',
      '`Headcount` is not editable at all: its cells are read-only, because inverting a `count` is a policy the rules do not state.',
    ],
    notes: [
      'A proposal is checked before it is committed: the engine applies the facts it worked out, re-runs the forward program, and compares. Aliasing and negation can both make a plausible-looking inverse wrong in a way no static analysis catches, so the check is what makes acting on the answer safe — and re-deriving is cheap here, because that is what this engine is for.',
      'Writability is opt-in per view, because the backward rules force joins the forward program never needed — about 1.8× to stand the graph up and 3× per incremental step, on a base of microseconds. Nothing is compiled until an edit is actually made, so listing a view costs nothing until somebody writes through it.',
    ],
  },

  // ---------------------------------------------------------------- 12
  {
    slug: 'put-insert',
    subOf: 'write-back',
    title: 'Inserting: .put insert',
    blurb: 'Supplying what an insert has no row to recover.',
    teaches: ['.put insert defaults(...)', '.put insert via R', 'multi-rule heads'],
    intro: [
      'Deleting and rewriting can replay the body against a row that exists. Inserting cannot — there is no row yet — so anything the head does not carry has no value, and nothing in the rules suggests one.',
      '`.put insert defaults(i = 0)` supplies it. The name is the *body* variable, not the column, and the value is whatever the application wants absent data to mean: here 0 is "no id yet", the way a vault reads 0 as "append to the end of the file".',
      'A head with several rules has a second gap. Deleting through one is mechanical — killing a disjunction means killing every disjunct — but *satisfying* it is a choice, because either rule alone would do. `.put insert via Contractor` names which, and its `defaults` fill in that rule\'s body.',
      'Both parts are optional and independent: `via` alone picks a rule, `defaults` alone fills a single-rule body, and together they do both.',
    ],
    source: `.in
.decl Employee(id: number, name: string, dept: string)
.decl Contractor(name: string, agency: string)

.out
.decl Roster(name: string, dept: string)
.put insert defaults(i = 0)
.decl Worker(name: string)
.put insert via Contractor defaults(a = "unassigned")

Roster(n, d) :- Employee(i, n, d).
Worker(n) :- Employee(i, n, d).
Worker(n) :- Contractor(n, a).
`,
    facts: {
      Employee: [
        [1, 'alice', 'eng'],
        [2, 'bob', 'eng'],
        [3, 'carol', 'ops'],
      ],
      Contractor: [['dana', 'Acme']],
    },
    writable: ['Roster', 'Worker'],
    tryThis: [
      'Add `erin, design` to `Roster`. It works now, and the new `Employee` fact carries the default id 0.',
      'Add `erin` to `Worker`. The row lands in `Contractor` — the rule `via` named — with the agency `unassigned`.',
      'Remove `dana` from `Worker`. No annotation was needed for that: a delete kills every derivation, so there is nothing to choose.',
      'Delete the `.put insert via Contractor defaults(...)` line and rebuild, then try adding to `Worker` again. The refusal explains that the head has several rules and asks which.',
      'Change the default to `defaults(i = 99)` and rebuild. New rows arrive with id 99 — the value is the application\'s convention, not the engine\'s.',
    ],
    notes: [
      'A default is not a fallback for a *missing* edit — it is a value for a variable the head genuinely does not determine. If the head carries the column, no default is consulted and none is allowed to override it.',
    ],
  },

  // ---------------------------------------------------------------- 13
  {
    slug: 'put-spread',
    subOf: 'write-back',
    title: 'Aggregates: .put spread',
    blurb: 'An edit to a total is a distribution, not a copy.',
    teaches: ['.put spread(min|max)', 'inverting sum', 'integer least-change'],
    intro: [
      'Rewriting a `sum` is not a copy. `Booked` holds 32 for alice because two `Hours` rows add to it, so asking for 40 is asking for eight hours to be spread across them — and *which* rows get how much is a real choice.',
      'Less of one than it looks, though. Over the reals, minimising the squared change subject to hitting the target gives an equal split, uniquely. What breaks is the arithmetic: `/` in this language truncates, so an equal split silently under-delivers whenever the member count does not divide the delta.',
      'And integer least-change is genuinely ambiguous: give everyone `⌊Δ/n⌋` and one extra unit to `Δ mod n` of them, and every choice of *which* is equally minimal. So `spread` takes exactly one knob and it is unavoidable — `min` gives the residual to the lowest member, `max` to the highest.',
      '`spread` only inverts `sum`. `Peak` below is a `max`, and its cells are read-only: dropping a maximum from 20 to 15 could mean any change to any row at or above 15, which is not a distribution and not one policy away from being one.',
    ],
    source: `.in
.decl Hours(name: string, week: number, hours: number)

.out
.decl Booked(name: string, total: number)
.put spread(min)
.decl Peak(name: string, most: number)

Booked(n, sum(h)) :- Hours(n, w, h).
Peak(n, max(h)) :- Hours(n, w, h).
`,
    facts: {
      Hours: [
        ['alice', 1, 12],
        ['alice', 2, 20],
        ['bob', 1, 35],
        ['carol', 1, 8],
        ['carol', 2, 8],
      ],
    },
    writable: ['Booked', 'Peak'],
    tryThis: [
      "Change alice's `Booked` total from 32 to 40. Eight hours over two weeks: +4 each, and `Hours` below shows 16 and 24.",
      'Now change it to 33. One hour over two weeks divides into nothing plus a remainder, and `spread(min)` gives the remainder to week 1.',
      'Change `spread(min)` to `spread(max)` and rebuild, then try 33 again. The odd hour goes to week 2 instead.',
      "Change bob's total. He has one `Hours` row, so the split is the whole delta and there is no residual to place.",
      'Delete the `.put spread(min)` line and rebuild. `Booked` goes read-only, and the refusal names the aggregation.',
    ],
    notes: [
      'The distribution is generated as ordinary Datalog — a count, a delta, a share, a product, a remainder and an absorber, one operation per rule because arithmetic here is flat. It is not a hand-written inverse, which is why it stays checkable against the forward program like everything else.',
    ],
  },

  // ---------------------------------------------------------------- 14
  {
    slug: 'put-into',
    subOf: 'write-back',
    title: 'Joins and refusals: .put into, .put none',
    blurb: 'Which side of a join a write lands on — and saying no on purpose.',
    teaches: ['.put into R', '.put none', 'ambiguous resolutions'],
    intro: [
      '`WhoLeads` joins two relations, so a row of it is supported by two facts, and removing the row could mean removing either. Both answers are correct and they mean different things: one says the person left, the other says the team lost its lead.',
      'The table below asks for an unambiguous answer, so with no annotation it reports `ambiguous` and names both candidates rather than picking. `.put into Employee` states the choice — this is Bancilhon and Spyratos\' constant complement, named directly. The other atoms are still replayed, so they still constrain which rows qualify; nothing just proposes a change to them.',
      'Holding a relation constant also makes the columns that come from it read-only. With `.put into Employee`, `lead` comes from `Team` and stops being editable — the affordance follows the annotation, with nothing on this page knowing about it.',
      '`.put none` is the other direction: read-only on purpose. `Headcount` would be refused anyway for being an un-annotated aggregate, and the refusal would sound like an omission. Declaring it says the decision was made.',
    ],
    source: `.in
.decl Employee(id: number, name: string, dept: string)
.decl Team(dept: string, lead: string)

.out
.decl WhoLeads(name: string, lead: string)
.put into Employee
.decl Headcount(dept: string, n: number)
.put none

WhoLeads(n, l) :- Employee(i, n, d), Team(d, l).
Headcount(d, count(n)) :- Employee(i, n, d).
`,
    facts: {
      Employee: [
        [1, 'alice', 'eng'],
        [2, 'bob', 'eng'],
        [3, 'carol', 'ops'],
      ],
      Team: [
        ['eng', 'frida'],
        ['ops', 'gus'],
      ],
    },
    writable: ['WhoLeads', 'Headcount'],
    writeOptions: { requireUnambiguous: true },
    tryThis: [
      'Remove alice from `WhoLeads`. One change, to `Employee` — the annotation said which side.',
      'Note the `lead` column is read-only: `Team` is held constant, so nothing can be written through it.',
      'Delete the `.put into Employee` line and rebuild. `lead` becomes editable again — and removing a row now reports `ambiguous`, naming both `Employee` and `Team`.',
      'With the annotation gone, rename a lead. It rewrites the `Team` fact, which changes it for everyone in that department at once.',
      'Its cells are read-only, so try removing a `Headcount` row instead. Refused by name, quoting `.put none`.',
      'Delete the `.put none` line and rebuild, then remove one again. Still refused — but now for being an un-annotated aggregate, which reads like something nobody got round to.',
    ],
    notes: [
      'Asking for an unambiguous answer is a per-request option, not a property of the program: `minimize` would instead shrink the result to a set with no redundant member and hand back one of them. Which is right depends on whether a wrong guess is recoverable, so the engine reports and the caller decides.',
      'The `/vault` demo in the sidebar is all four of these at full size: a markdown file lowered into facts, nine views derived from them, and edits to the views rewriting the markdown.',
    ],
  },
]

export function lessonBySlug(slug: string): Lesson | undefined {
  return LESSONS.find((l) => l.slug === slug)
}

/** The lessons that refine this one. */
export function subLessons(slug: string): readonly Lesson[] {
  return LESSONS.filter((l) => l.subOf === slug)
}

/** The steps of the tutorial proper — refinements excluded, since they are
 *  numbered within their parent rather than after it. */
export const TOP_LEVEL = LESSONS.filter((l) => !l.subOf)

/** The step number as the tutorial writes it: `4` for a lesson, `11.2` for the
 *  second refinement of lesson 11.
 *
 *  Sub-lessons share their parent's number rather than continuing the sequence,
 *  so the tutorial reads as eleven steps — one of which has three parts — and
 *  not as fourteen of which the last four happen to be about annotations. */
export function lessonLabel(lesson: Lesson): string {
  if (!lesson.subOf) return String(TOP_LEVEL.indexOf(lesson) + 1)
  const parent = lessonBySlug(lesson.subOf)
  const nth = subLessons(lesson.subOf).indexOf(lesson) + 1
  /* c8 ignore next */
  if (!parent) return String(nth)
  return `${TOP_LEVEL.indexOf(parent) + 1}.${nth}`
}

/** The tutorial as the nav renders it: top-level lessons, each with whatever
 *  refines it. One level deep, which is all `subOf` allows. */
export function lessonOutline(): ReadonlyArray<{ lesson: Lesson; children: readonly Lesson[] }> {
  return LESSONS.filter((l) => !l.subOf).map((lesson) => ({
    lesson,
    children: subLessons(lesson.slug),
  }))
}

/** Previous / next, for the footer links. */
export function lessonNeighbours(slug: string): {
  previous: Lesson | undefined
  next: Lesson | undefined
} {
  const i = LESSONS.findIndex((l) => l.slug === slug)
  if (i === -1) return { previous: undefined, next: undefined }
  return { previous: LESSONS[i - 1], next: LESSONS[i + 1] }
}
