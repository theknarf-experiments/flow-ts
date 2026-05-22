// Port of `Program` in flowlog/src/parsing/src/parser.rs

import type { RelDecl } from './decl.js'
import type { FLRule } from './rule.js'

export class Program {
  constructor(
    public readonly edbs: RelDecl[],
    public readonly idbs: RelDecl[],
    public readonly rules: FLRule[],
  ) {}

  toString(): string {
    const edbs = this.edbs.map((d) => d.toString()).join('\n')
    const idbs = this.idbs.map((d) => d.toString()).join('\n')
    const rules = this.rules.map((r) => r.toString()).join('\n')
    return `.in \n${edbs}\n.printsize \n${idbs}\n.rule \n${rules}`
  }
}
