// Port of flowlog/src/strata/src/dependencies.rs

import type { Program } from '../ast/index.js'

/** Rule-level dependency graph derived from a parsed FlowLog program. */
export class DependencyGraph {
  constructor(
    public readonly ruleIdbNames: string[],
    /** rule_id → set of rule_ids that the rule depends on (positive + negative bodies). */
    public readonly ruleDependencyMap: Map<number, Set<number>>,
    /** rule_id → set of rule_ids that appear under negation in the rule body. */
    public readonly negationDependencyMap: Map<number, Set<number>>,
  ) {}

  static fromParser(program: Program): DependencyGraph {
    const rules = program.rules
    const ruleIdbNames = rules.map((rule) => rule.head.name)

    // head2rule_ids_map: head_name → list of rule_ids producing that head
    const head2ruleIds = new Map<string, number[]>()
    for (let ruleId = 0; ruleId < rules.length; ruleId++) {
      const headName = rules[ruleId]!.head.name
      let ids = head2ruleIds.get(headName)
      if (!ids) {
        ids = []
        head2ruleIds.set(headName, ids)
      }
      ids.push(ruleId)
    }

    const ruleDependencyMap = new Map<number, Set<number>>()
    const negationDependencyMap = new Map<number, Set<number>>()
    for (let i = 0; i < rules.length; i++) {
      ruleDependencyMap.set(i, new Set())
      negationDependencyMap.set(i, new Set())
    }

    for (let ruleId = 0; ruleId < rules.length; ruleId++) {
      const rule = rules[ruleId]!
      for (const predicate of rule.rhs) {
        let atomName: string
        switch (predicate.kind) {
          case 'Atom':
            atomName = predicate.atom.name
            break
          case 'NegatedAtom': {
            const negatedHeadIds = head2ruleIds.get(predicate.atom.name)
            if (negatedHeadIds) {
              const negSet = negationDependencyMap.get(ruleId)!
              for (const id of negatedHeadIds) negSet.add(id)
            }
            atomName = predicate.atom.name
            break
          }
          case 'Compare':
            continue
        }

        const headIds = head2ruleIds.get(atomName)
        if (headIds) {
          const depSet = ruleDependencyMap.get(ruleId)!
          for (const id of headIds) depSet.add(id)
        }
      }
    }

    return new DependencyGraph(ruleIdbNames, ruleDependencyMap, negationDependencyMap)
  }

  toString(): string {
    const lines: string[] = []
    lines.push('.dependency graph (rule_id: dependent rule_ids): ')
    for (const ruleId of [...this.ruleDependencyMap.keys()].sort((a, b) => a - b)) {
      const deps = [...this.ruleDependencyMap.get(ruleId)!].sort((a, b) => a - b)
      if (deps.length > 0) {
        lines.push(`${ruleId}: [${deps.join(', ')}]`)
      } else {
        lines.push(`${ruleId}: `)
      }
    }

    lines.push('')
    lines.push('.negation dependency graph (rule_id: dependent negation rule_ids): ')
    for (const ruleId of [...this.negationDependencyMap.keys()].sort((a, b) => a - b)) {
      const deps = [...this.negationDependencyMap.get(ruleId)!].sort((a, b) => a - b)
      if (deps.length > 0) {
        lines.push(`${ruleId}: [${deps.join(', ')}]`)
      }
    }

    return lines.join('\n') + '\n'
  }
}
