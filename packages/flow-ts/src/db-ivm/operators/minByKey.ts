// Specialised min-by-key aggregation that's O(deltas) per tick instead
// of O(total candidates per key) like the generic `reduce`. Matches the
// shape of differential-dataflow's `threshold_semigroup` with a Min
// semiring, which is what Rust FlowLog reaches for on recursive Min
// aggregations.
//
// Per tick:
//   • Walk the deltas, computing the new minimum candidate per group.
//   • For each group whose minimum decreased, emit -1 of the old min and
//     +1 of the new min. Groups whose min didn't move emit nothing.
//   • Persist the new minima for the next tick.
//
// Limitations: positive-multiplicity input only. Negative diffs at the
// input would require a fallback (we'd need to enumerate next-min on
// retraction). The aggregations we care about under recursion (Datalog
// CC / shortest-paths style) only ever insert at the input, so this is
// fine in practice. The output is positive/negative diffs as the
// current min changes — those compose correctly with downstream
// operators.

import { DifferenceStreamWriter, UnaryOperator } from '../graph.js'
import { StreamBuilder } from '../d2.js'
import { MultiSet } from '../multiset.js'
import type { DifferenceStreamReader } from '../graph.js'
import type { IStreamBuilder, KeyValue, PipedOperator } from '../types.js'

export class MinByKeyOperator<K> extends UnaryOperator<
  KeyValue<K, number>
> {
  #current = new Map<K, number>()

  run(): void {
    if (this.inputs[0]!.isEmpty()) return
    // For each key touched this tick, the best candidate we've seen so
    // far. Only inspected if at least one positive-diff record arrived
    // for that key.
    const proposed = new Map<K, number>()
    for (const message of this.inputMessages() as Array<
      MultiSet<KeyValue<K, number>>
    >) {
      const inner = message.getInner()
      for (let i = 0; i < inner.length; i++) {
        const entry = inner[i]!
        const mult = entry[1]
        if (mult <= 0) continue
        const kv = entry[0]
        const key = kv[0]
        const value = kv[1]
        const seen = proposed.get(key)
        if (seen === undefined || value < seen) proposed.set(key, value)
      }
    }
    if (proposed.size === 0) return
    const result: Array<[KeyValue<K, number>, number]> = []
    for (const [key, candidate] of proposed) {
      const current = this.#current.get(key)
      if (current === undefined) {
        result.push([[key, candidate], 1])
        this.#current.set(key, candidate)
      } else if (candidate < current) {
        result.push([[key, current], -1])
        result.push([[key, candidate], 1])
        this.#current.set(key, candidate)
      }
    }
    if (result.length > 0) this.output.sendData(new MultiSet(result))
  }
}

/**
 * Per-key running minimum. Input `[key, value]` pairs; output is the
 * stream of `[key, currentMin]` diffs as new candidates beat the
 * stored minimum. Positive-multiplicity input only.
 */
export function minByKey<K>(): PipedOperator<
  KeyValue<K, number>,
  KeyValue<K, number>
> {
  return (stream) => {
    const output = new StreamBuilder<KeyValue<K, number>>(
      stream.graph,
      new DifferenceStreamWriter<KeyValue<K, number>>(),
    )
    const operator = new MinByKeyOperator<K>(
      stream.graph.getNextOperatorId(),
      stream.connectReader() as DifferenceStreamReader<KeyValue<K, number>>,
      output.writer,
    )
    stream.graph.addOperator(operator)
    return output
  }
}
