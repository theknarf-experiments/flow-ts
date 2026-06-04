// Parse the Datalog program. The .dl source is imported as a raw
// string via Vite's `?raw` query (same file the server side
// `kanban.dl` would consume in batch mode).

import { parseProgram } from '@flow-ts/parsing'
import kanbanDl from '../shared/kanban.dl?raw'

export const PROGRAM = parseProgram(kanbanDl, { grammarSource: 'kanban.dl' })
