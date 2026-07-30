// String-keyed distinct. The generic `distinct` operator hashes every
// input value through murmur / FNV — necessary when values can be any
// shape — but when the input is already a primitive string, JS Map can
// use the string itself as the key with native hashing. This shaves a
// noticeable chunk of CPU off the dedup-heavy paths (TC, recursive
// IDB heads) where every row crosses the dedup gate.
//
// Semantics: per-key reference counting in a Map<string, number>. Emit
// +1 when a value transitions from 0 → positive, -1 when it goes
// positive → 0. Matches the standard `distinct` set-semantics output.

import { DifferenceStreamWriter, UnaryOperator } from '../graph.js'
import { StreamBuilder } from '../d2.js'
import { MultiSet } from '../multiset.js'
import type { DifferenceStreamReader } from '../graph.js'
import type { IStreamBuilder, PipedOperator } from '../types.js'

export class StringDistinctOperator extends UnaryOperator<string> {
  #values = new Map<string, number>()

  run(): void {
    if (this.inputs[0]!.isEmpty()) return
    // Per-tick net multiplicity by string value.
    const tick = new Map<string, number>()
    for (const message of this.inputMessages() as Array<MultiSet<string>>) {
      const inner = message.getInner()
      for (let i = 0; i < inner.length; i++) {
        const entry = inner[i]!
        const value = entry[0]
        const diff = entry[1]
        tick.set(value, (tick.get(value) ?? 0) + diff)
      }
    }
    const result: Array<[string, number]> = []
    for (const [value, delta] of tick) {
      const oldM = this.#values.get(value) ?? 0
      const newM = oldM + delta
      if (newM === 0) this.#values.delete(value)
      else this.#values.set(value, newM)
      if (oldM <= 0 && newM > 0) result.push([value, 1])
      else if (oldM > 0 && newM <= 0) result.push([value, -1])
    }
    if (result.length > 0) this.output.sendData(new MultiSet(result))
  }
}

/** Set-semantics dedup for streams of primitive strings. ~3-5× faster
 *  than the generic `distinct()` because it skips the murmur/FNV hash
 *  step (JS Map hashes strings natively). */
export function stringDistinct(): PipedOperator<string, string> {
  return (stream) => {
    const output = new StreamBuilder<string>(
      stream.graph,
      new DifferenceStreamWriter<string>(),
    )
    const operator = new StringDistinctOperator(
      stream.graph.getNextOperatorId(),
      stream.connectReader() as DifferenceStreamReader<string>,
      output.writer,
    )
    stream.graph.addOperator(operator)
    return output
  }
}
