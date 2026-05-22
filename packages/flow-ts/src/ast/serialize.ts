// Serialize a parsed Program back into FlowLog .dl source. The AST classes'
// own `toString()` methods produce a human-readable form that isn't
// round-trippable through the parser (`.input`/`.output` directives are
// elided, sections are merged); this serializer produces output that
// `parseProgram` can read again, preserving the structure round-trip.

import { dataTypeToString } from './decl.js'
import type { Program } from './program.js'

/** Render a Program as valid FlowLog source. */
export function programToDl(program: Program): string {
  const lines: string[] = []

  if (program.edbs.length > 0) {
    lines.push('.in')
    for (const edb of program.edbs) {
      const attrs = edb.attributes
        .map((a) => `${a.name}: ${dataTypeToString(a.dataType)}`)
        .join(', ')
      lines.push(`.decl ${edb.name}(${attrs})`)
      if (edb.path) lines.push(`.input ${edb.path}`)
    }
  }

  if (program.idbs.length > 0) {
    lines.push('.printsize')
    for (const idb of program.idbs) {
      const attrs = idb.attributes
        .map((a) => `${a.name}: ${dataTypeToString(a.dataType)}`)
        .join(', ')
      lines.push(`.decl ${idb.name}(${attrs})`)
      if (idb.path) lines.push(`.output ${idb.path}`)
    }
  }

  if (program.rules.length > 0) {
    lines.push('.rule')
    for (const rule of program.rules) {
      lines.push(rule.toString())
    }
  }

  return lines.join('\n') + '\n'
}
