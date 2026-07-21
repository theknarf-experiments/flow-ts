import { parseProgram } from '@flow-ts/parsing'
import { openSession } from './dist/index.js'

const SOURCE = `\
.in
.decl File(path: string, mtime: number)
.decl Tag(path: string, tag: string)

.printsize
.decl FlowMdAdHoc()

.rule
Tag(p, "synthetic") :- File(p, m).
FlowMdAdHoc(p, t) :- Tag(p, t).
`

const out = []
try {
  const session = openSession(parseProgram(SOURCE, { grammarSource: 'inline' }), {}, (rel, row, mult) => {
    if (rel === 'FlowMdAdHoc') out.push([[...row], mult])
  })
  session.update('File', ['a.md', 1], 1)
  session.update('Tag', ['a.md', 'literal'], 1)
  session.advance()
  console.log('rows:', JSON.stringify(out))
} catch (e) {
  console.log('THREW:', e.message)
  console.log(e.stack.split('\n').slice(1, 5).join('\n'))
}
