// Queue-based recursive iteration. No versions, no frontiers: the body's
// output is fed back into its own input, and `D2.run()` naturally exits
// when no operator has queued data — i.e., when the body emits no new
// diffs against its accumulated state.
//
// Each operator in db-ivm maintains its own state across `run()` calls
// (e.g. JoinOperator's indexA/indexB), so each iteration only processes
// the delta from the previous iteration. Fixpoint = body produces empty
// output for a tick.
//
// This is the analog of Rust differential-dataflow's `scope.iterative`,
// minus the time-tracking machinery that's not needed when each operator
// is itself incremental and the scheduler is queue-driven.

import { UnaryOperator, DifferenceStreamWriter } from '../graph.js'
import type { DifferenceStreamReader } from '../graph.js'
import { StreamBuilder } from '../d2.js'
import type { MultiSet } from '../multiset.js'
import type { IStreamBuilder, PipedOperator } from '../types.js'
import { concat } from './concat.js'

/**
 * Drains the body's output and writes each MultiSet to:
 *   1. The feedback stream — re-enters the body's input on the next tick.
 *   2. The forward output — visible to downstream consumers and to the
 *      caller of `iterate`.
 *
 * Empty MultiSets are dropped from both paths so that fixpoint (= empty
 * body output) doesn't keep the scheduler busy.
 */
export class FeedbackOperator<T> extends UnaryOperator<T> {
  #feedbackWriter: DifferenceStreamWriter<T>

  constructor(
    id: number,
    inputA: DifferenceStreamReader<T>,
    forwardOutput: DifferenceStreamWriter<T>,
    feedbackWriter: DifferenceStreamWriter<T>,
  ) {
    super(id, inputA, forwardOutput)
    this.#feedbackWriter = feedbackWriter
  }

  run(): void {
    for (const message of this.inputMessages() as Array<MultiSet<T>>) {
      const inner = message.getInner()
      if (inner.length === 0) continue
      this.#feedbackWriter.sendData(message)
      this.output.sendData(message)
    }
  }
}

/**
 * Recursive iteration: `f` defines the body, which receives an input
 * stream containing the original seed plus everything emitted by the
 * body on prior ticks. The body must dedupe its own output (e.g. via
 * `distinct`) so the iteration eventually reaches a fixpoint where the
 * body produces no new diffs.
 *
 * ```ts
 * const reach = source.pipe(
 *   iterate((stream) =>
 *     stream.pipe(
 *       map((x) => x),                  // base case
 *       concat(stream.pipe(...)),       // recursive step
 *       map((r) => [r, null] as const), // key for distinct
 *       distinct(),
 *       map(([r]) => r),
 *     ),
 *   ),
 * )
 * ```
 */
export function iterate<T>(
  f: (stream: IStreamBuilder<T>) => IStreamBuilder<T>,
): PipedOperator<T, T> {
  return (input: IStreamBuilder<T>): IStreamBuilder<T> => {
    const graph = input.graph
    const feedbackStream = new StreamBuilder<T>(graph, new DifferenceStreamWriter<T>())

    // Body sees the original seed ⊕ everything we've fed back.
    const entered = input.pipe(concat<T, T>(feedbackStream))
    const result = f(entered)

    // The forward output is what `iterate` returns to its caller. The
    // feedback writer is `feedbackStream.writer` so that drains push back
    // into the body on the next tick.
    const forwardOutput = new StreamBuilder<T>(graph, new DifferenceStreamWriter<T>())
    const op = new FeedbackOperator<T>(
      graph.getNextOperatorId(),
      result.connectReader(),
      forwardOutput.writer,
      feedbackStream.writer,
    )
    graph.addOperator(op)
    return forwardOutput
  }
}
