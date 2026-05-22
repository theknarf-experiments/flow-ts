// Multi-variable iteration on top of `@flow-ts/db-ivm`. The vendored
// db-ivm has no version machinery, so we don't need ingress / egress
// scope wrappers — db-ivm operators maintain their own state across
// `run()` calls (joins keep their indexes, distinct keeps its hash
// table) so persistent ingress is implicit. Externals are simply read
// from the enclosing closure.
//
// For each variable we create:
//   * a feedback writer (the variable's stream identity)
//   * a `FeedbackOperator` that drains the body's per-variable output,
//     pushes it back into the feedback writer, and forwards it to the
//     caller-visible result stream.
//
// Convergence: db-ivm's `D2.run()` loops while any operator has queued
// input. The body emits empty diffs once it reaches fixpoint, no data
// flows into the feedback writers, no operator has pending work, the
// run loop exits.

import {
  type D2,
  DifferenceStreamWriter,
  type IStreamBuilder,
  StreamBuilder,
  UnaryOperator,
} from '@flow-ts/db-ivm'
import type { MultiSet } from '@flow-ts/db-ivm'

/** Mirrors db-ivm's own FeedbackOperator. Re-declared here so flow-ts
 *  can wire one per recursive head without exposing internal classes. */
class TeeFeedbackOperator<T> extends UnaryOperator<T> {
  #feedback: DifferenceStreamWriter<T>

  constructor(
    id: number,
    input: import('@flow-ts/db-ivm').DifferenceStreamReader<T>,
    forward: DifferenceStreamWriter<T>,
    feedback: DifferenceStreamWriter<T>,
  ) {
    super(id, input, forward)
    this.#feedback = feedback
  }

  run(): void {
    for (const message of this.inputMessages() as Array<MultiSet<T>>) {
      const inner = message.getInner()
      if (inner.length === 0) continue
      this.#feedback.sendData(message)
      this.output.sendData(message)
    }
  }
}

/**
 * Multi-variable iteration. `variableNames` are the recursive head names;
 * the body receives a handle per name (an `IStreamBuilder` placeholder)
 * and must return one stream per name carrying that head's new value.
 *
 * Externals (EDBs, prior-stratum IDBs) are read directly from the
 * enclosing scope — db-ivm's operators are stateful, so an external
 * piped through a join inside the body stays visible across all
 * iterations automatically.
 */
export function iterateMulti<
  VarKeys extends string,
  VarVals extends Record<VarKeys, unknown>,
>(
  graph: D2,
  variableNames: readonly VarKeys[],
  body: (variables: { [K in VarKeys]: IStreamBuilder<VarVals[K]> }) => {
    [K in VarKeys]: IStreamBuilder<VarVals[K]>
  },
): { [K in VarKeys]: IStreamBuilder<VarVals[K]> } {
  // For each variable, create a writer that the FeedbackOperator will
  // later push into, and a placeholder StreamBuilder the body reads from.
  const feedbackWriters = {} as { [K in VarKeys]: DifferenceStreamWriter<VarVals[K]> }
  const variables = {} as { [K in VarKeys]: IStreamBuilder<VarVals[K]> }
  for (const name of variableNames) {
    const writer = new DifferenceStreamWriter<VarVals[typeof name]>()
    feedbackWriters[name] = writer
    variables[name] = new StreamBuilder<VarVals[typeof name]>(graph, writer)
  }

  // Run the body. It produces one new value per recursive head.
  const results = body(variables)

  // Wire each result back into its feedback writer, and also forward to
  // a caller-visible stream so the outer scope can sink the converged value.
  const forwards = {} as { [K in VarKeys]: IStreamBuilder<VarVals[K]> }
  for (const name of variableNames) {
    const result = results[name]
    const forwardWriter = new DifferenceStreamWriter<VarVals[typeof name]>()
    const op = new TeeFeedbackOperator<VarVals[typeof name]>(
      graph.getNextOperatorId(),
      result.connectReader(),
      forwardWriter,
      feedbackWriters[name],
    )
    graph.addOperator(op)
    forwards[name] = new StreamBuilder<VarVals[typeof name]>(graph, forwardWriter)
  }
  return forwards
}
