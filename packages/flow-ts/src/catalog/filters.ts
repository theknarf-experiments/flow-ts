// Port of flowlog/src/catalog/src/filters.rs

import type { Const } from '../ast/index.js'
import { constToString } from '../ast/index.js'
import {
  type AtomArgumentSignature,
  SignatureMap,
  SignatureSet,
} from './atoms.js'

/**
 * Local equality/placeholder constraints learned from a single rule body.
 *
 *   arc(x, x)     → var_eq_map: { 1st x → 0th x position }
 *   arc(x, 5)     → const_map:   { 2nd position → Integer(5) }
 *   arc(x, _)     → placeholder_set: { 2nd position }
 */
export class BaseFilters {
  constructor(
    public readonly varEqMap: SignatureMap<AtomArgumentSignature>,
    public readonly constMap: SignatureMap<Const>,
    public readonly placeholderSet: SignatureSet,
  ) {}

  /** True if this argument is constrained by any of the three filter kinds. */
  isConstOrVarEqOrPlaceholder(arg: AtomArgumentSignature): boolean {
    return (
      this.varEqMap.has(arg) ||
      this.constMap.has(arg) ||
      this.placeholderSet.has(arg)
    )
  }

  isEmpty(): boolean {
    return (
      this.varEqMap.isEmpty() &&
      this.constMap.isEmpty() &&
      this.placeholderSet.isEmpty()
    )
  }

  toString(): string {
    const lines: string[] = []
    lines.push('Variable Eq Constraints Map:')
    for (const [alias, target] of this.varEqMap.entries()) {
      lines.push(`  ${alias.toString()} -> ${target.toString()}`)
    }
    lines.push('')
    lines.push('Constant Map:')
    for (const [arg, c] of this.constMap.entries()) {
      lines.push(`  ${arg.toString()} -> ${constToString(c)}`)
    }
    lines.push('')
    lines.push('Placeholder Set:')
    for (const arg of this.placeholderSet) {
      lines.push(`  ${arg.toString()}`)
    }
    return lines.join('\n') + '\n'
  }
}
