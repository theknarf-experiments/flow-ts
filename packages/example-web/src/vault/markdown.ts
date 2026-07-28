// A deliberately tiny markdown "plugin", in the flow-md sense: it turns source
// text into Datalog facts, and it turns a fact change back into source text.
//
// The split matters more than the parser does. Facts are *values* — a task's
// path, line, status and text — and nothing about where they sit in the file
// crosses into the engine. When a write comes back it names a fact, and this
// module finds that fact in the *current* text and rewrites the line.
//
// That is the whole reason spans aren't carried through the dataflow. A span is
// a byte offset, and byte offsets go stale the moment anything above them
// changes; a fact doesn't. flow-md keeps a parallel provenance stream to solve
// this and has to worry about it going stale. Re-reading the file at write time
// costs one parse and cannot be stale by construction.

export type Row = readonly (string | number)[]

export interface VaultFacts {
  MdTask: Row[]
  MdHeading: Row[]
}

const TASK = /^(\s*)- \[( |x)\] (.*)$/
const HEADING = /^(#{1,6}) (.*)$/

/** Lower a set of notes into facts. Line numbers are 1-based. */
export function parseVault(notes: Record<string, string>): VaultFacts {
  const facts: VaultFacts = { MdTask: [], MdHeading: [] }
  for (const [path, source] of Object.entries(notes)) {
    source.split('\n').forEach((line, i) => {
      const no = i + 1
      const task = TASK.exec(line)
      if (task) {
        facts.MdTask.push([path, no, task[2] === 'x' ? 'closed' : 'open', task[3]!])
        return
      }
      const heading = HEADING.exec(line)
      if (heading) facts.MdHeading.push([path, no, heading[1]!.length, heading[2]!])
    })
  }
  return facts
}

/** Why a write could not be applied to the text. */
export interface WriteFailure {
  reason: string
}

/** Apply one fact-level change to the notes, returning the new sources.
 *
 *  Every case re-reads the current text rather than trusting a remembered
 *  position: the row says which line it came from, and that line is checked to
 *  still hold the fact being changed. A stale row is refused, not guessed at. */
export function applyToVault(
  notes: Record<string, string>,
  change: { kind: 'del' | 'ins' | 'upd'; rel: string; row: Row; newRow?: Row },
): Record<string, string> | WriteFailure {
  const { rel, row, newRow, kind } = change

  if (rel === 'MdTask' && kind === 'ins') {
    // Line 0 is the convention the `.put insert defaults(l = 0)` annotation
    // feeds in: the caller cannot know a line number for a task that does not
    // exist yet, so 0 means "append" and the real number comes back from the
    // re-parse. Anything else inserts before that line.
    const path = String(row[0])
    const source = notes[path]
    if (source === undefined) return { reason: `no note "${path}"` }
    const lines = source.split('\n')
    const rendered = `- [${String(row[2]) === 'closed' ? 'x' : ' '}] ${String(row[3])}`
    const at = Number(row[1])
    if (at > 0 && at <= lines.length) lines.splice(at - 1, 0, rendered)
    else {
      // Append before a trailing blank line, so the note keeps its shape.
      const end = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
      lines.splice(end, 0, rendered)
    }
    return { ...notes, [path]: lines.join('\n') }
  }

  if (rel === 'MdTask') {
    const [path, line] = [String(row[0]), Number(row[1])]
    const source = notes[path]
    if (source === undefined) return { reason: `no note "${path}"` }
    const lines = source.split('\n')
    const current = lines[line - 1]
    if (current === undefined) return { reason: `${path} has no line ${line}` }
    const parsed = TASK.exec(current)
    if (!parsed) return { reason: `${path}:${line} is no longer a task` }
    // The fact has to still be what the request thinks it is.
    const status = parsed[2] === 'x' ? 'closed' : 'open'
    if (status !== row[2] || parsed[3] !== row[3]) {
      return { reason: `${path}:${line} changed underneath this edit` }
    }

    if (kind === 'del') {
      lines.splice(line - 1, 1)
      return { ...notes, [path]: lines.join('\n') }
    }
    if (kind === 'upd' && newRow) {
      const mark = String(newRow[2]) === 'closed' ? 'x' : ' '
      lines[line - 1] = `${parsed[1]}- [${mark}] ${String(newRow[3])}`
      return { ...notes, [path]: lines.join('\n') }
    }
  }

  if (rel === 'MdHeading' && (kind === 'upd' || kind === 'del')) {
    const [path, line] = [String(row[0]), Number(row[1])]
    const source = notes[path]
    if (source === undefined) return { reason: `no note "${path}"` }
    const lines = source.split('\n')
    const parsed = HEADING.exec(lines[line - 1] ?? '')
    if (!parsed) return { reason: `${path}:${line} is no longer a heading` }
    if (parsed[2] !== row[3]) return { reason: `${path}:${line} changed underneath this edit` }
    if (kind === 'del') lines.splice(line - 1, 1)
    else lines[line - 1] = `${'#'.repeat(Number(newRow![2]))} ${String(newRow![3])}`
    return { ...notes, [path]: lines.join('\n') }
  }

  // Anything else has no text of its own. `Doc`, for instance, is derived from
  // a heading, so a write to it is traced to that heading before it ever gets
  // here — if one arrives, something upstream skipped a rule.
  return {
    reason: `no way to write ${kind} ${rel}(${row.join(', ')}) back to markdown`,
  }
}
