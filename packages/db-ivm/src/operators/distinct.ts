import { DifferenceStreamWriter, UnaryOperator } from '../graph.js'
import { StreamBuilder } from '../d2.js'
import { hash } from '../hashing/index.js'
import { MultiSet } from '../multiset.js'
import type { Hash } from '../hashing/index.js'
import type { DifferenceStreamReader } from '../graph.js'
import type { IStreamBuilder, KeyValue } from '../types.js'

type Multiplicity = number

type GetValue<T> = T extends KeyValue<any, infer V> ? V : never

/**
 * Operator that removes duplicates
 */
export class DistinctOperator<
  T extends KeyValue<any, any>,
> extends UnaryOperator<T, KeyValue<number, GetValue<T>>> {
  #by: (value: T) => any
  #values: Map<Hash, Multiplicity> // keeps track of the number of times each value has been seen

  constructor(
    id: number,
    input: DifferenceStreamReader<T>,
    output: DifferenceStreamWriter<KeyValue<number, GetValue<T>>>,
    by: (value: T) => any = (value: T) => value,
  ) {
    super(id, input, output)
    this.#by = by
    this.#values = new Map()
  }

  run(): void {
    const updatedValues = new Map<Hash, [Multiplicity, T]>()

    // Compute the new multiplicity for each value
    for (const message of this.inputMessages()) {
      const inner = message.getInner()
      for (let i = 0; i < inner.length; i++) {
        const pair = inner[i]!
        const value = pair[0]
        const diff = pair[1]
        const hashedValue = hash(this.#by(value))

        const existing = updatedValues.get(hashedValue)
        const oldMultiplicity =
          existing !== undefined
            ? existing[0]
            : (this.#values.get(hashedValue) ?? 0)
        updatedValues.set(hashedValue, [oldMultiplicity + diff, value])
      }
    }

    const result: Array<[KeyValue<number, GetValue<T>>, number]> = []

    // Check which values became visible or disappeared. `hashedValue` is
    // by construction `hash(this.#by(value))`, so reuse it for the emitted
    // record's key rather than re-hashing on every diff we surface.
    for (const [hashedValue, pair] of updatedValues) {
      const newMultiplicity = pair[0]
      const value = pair[1]
      const oldMultiplicity = this.#values.get(hashedValue) ?? 0

      if (newMultiplicity === 0) {
        this.#values.delete(hashedValue)
      } else {
        this.#values.set(hashedValue, newMultiplicity)
      }

      if (oldMultiplicity <= 0 && newMultiplicity > 0) {
        result.push([[hashedValue, value[1]], 1])
      } else if (oldMultiplicity > 0 && newMultiplicity <= 0) {
        result.push([[hashedValue, value[1]], -1])
      }
    }

    if (result.length > 0) {
      this.output.sendData(new MultiSet(result))
    }
  }
}

/**
 * Removes duplicate values
 */
export function distinct<T extends KeyValue<any, any>>(
  by: (value: T) => any = (value: T) => value,
) {
  return (stream: IStreamBuilder<T>): IStreamBuilder<T> => {
    const output = new StreamBuilder<T>(
      stream.graph,
      new DifferenceStreamWriter<T>(),
    )
    const operator = new DistinctOperator<T>(
      stream.graph.getNextOperatorId(),
      stream.connectReader(),
      output.writer,
      by,
    )
    stream.graph.addOperator(operator)
    return output
  }
}
