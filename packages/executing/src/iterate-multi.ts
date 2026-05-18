// Multi-variable iterate, mirroring Rust DD's `scope.iterative` + multiple
// `SemigroupVariable` pattern.
//
// d2ts ships a single-variable `iterate(f)` that ingresses its seed stream
// with a built-in negation trick: ingress sends `+data` at inner version
// `(0,0)` AND `-data` at `(0,1)`, so the seed's cumulative contribution
// vanishes after iter 0. That works for self-contained recursions like the
// canonical "x ← x*2 ∪ x" example, but it breaks Datalog-style joins where
// an EDB needs to be visible at *every* inner iteration.
//
// This module exposes:
//
//   - `persistentIngress`: like d2ts's internal `ingress`, but without the
//     v1 negation — matches DD's `.enter(scope)` semantics. Outer data is
//     visible at every inner version through downstream operator indexes.
//
//   - `iterateMulti`: opens an iteration scope, ingresses N external
//     streams, creates N independent feedback variables, runs a body, and
//     wires the body's per-variable outputs back as feedback. Egresses
//     final values back to the outer scope. The equivalent of:
//
//     ```rust
//     scope.iterative(|scope| {
//         let var_a = construct_var(scope);
//         let outer_a_inside = outer_a.enter(scope);
//         // ...build...
//         var_a.set(&new_a);
//         new_a.leave()
//     })
//     ```

import {
  type D2,
  EgressOperator,
  IngressOperator,
  FeedbackOperator,
  type IStreamBuilder,
  MessageType,
  StreamBuilder,
} from '@electric-sql/d2ts'

// d2ts's main entry doesn't re-export DifferenceStreamWriter from `graph.js`,
// and the package.json `exports` field forbids deep imports. We synthesize
// new writers by reflecting on a throwaway input's `.writer.constructor`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyWriter = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedWriterCtor: (new <T>() => any) | null = null

function makeWriter<T>(graph: D2): AnyWriter {
  if (!cachedWriterCtor) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const probe = graph.newInput<unknown>() as unknown as { writer: { constructor: any } }
    cachedWriterCtor = probe.writer.constructor as new <U>() => AnyWriter
  }
  return new cachedWriterCtor<T>()
}

/**
 * Persistent variant of d2ts's internal `ingress()`. Sends each incoming
 * outer-scope datum at the extended inner version, with no negation at
 * inner step 1. Operators consuming the resulting stream (joins, etc.)
 * accumulate state across the iteration; the ingressed data behaves as a
 * persistent external in the loop, matching DD's `.enter(scope)`.
 */
class PersistentIngressOperator<T> extends IngressOperator<T> {
  override run(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const self = this as any
    for (const message of self.inputMessages()) {
      if (message.type === MessageType.DATA) {
        const { version, collection } = message.data
        const newVersion = version.extend()
        self.output.sendData(newVersion, collection)
        // intentionally NO `output.sendData(newVersion.applyStep(1), collection.negate())`
      } else if (message.type === MessageType.FRONTIER) {
        const frontier = message.data
        const newFrontier = frontier.extend()
        if (!self.inputFrontier().lessEqual(newFrontier)) {
          throw new Error('Invalid frontier update')
        }
        self.setInputFrontier(newFrontier)
      }
    }
    if (!self.outputFrontier.lessEqual(self.inputFrontier())) {
      throw new Error('Invalid frontier state')
    }
    if (self.outputFrontier.lessThan(self.inputFrontier())) {
      self.outputFrontier = self.inputFrontier()
      self.output.sendFrontier(self.outputFrontier)
    }
  }
}

/** Bring an outer-scope stream into the current iteration scope, persistently. */
export function persistentIngress<T>(stream: IStreamBuilder<T>): IStreamBuilder<T> {
  const graph = stream.graph
  const writer = makeWriter<T>(graph as D2)
  const out = new StreamBuilder<T>(graph, writer)
  // The PersistentIngressOperator constructor signature is inherited from
  // IngressOperator: (id, inputReader, output, initialFrontier).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const op = new (PersistentIngressOperator as any)(
    graph.getNextOperatorId(),
    stream.connectReader(),
    writer,
    graph.frontier(),
  )
  graph.addOperator(op)
  graph.addStream(out.connectReader())
  return out
}

/** Pop an inner-scope stream back into the outer scope. */
function egressFrom<T>(stream: IStreamBuilder<T>): IStreamBuilder<T> {
  const graph = stream.graph
  const writer = makeWriter<T>(graph as D2)
  const out = new StreamBuilder<T>(graph, writer)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const op = new (EgressOperator as any)(
    graph.getNextOperatorId(),
    stream.connectReader(),
    writer,
    graph.frontier(),
  )
  graph.addOperator(op)
  graph.addStream(out.connectReader())
  return out
}

/**
 * Multi-variable iterate. The body receives:
 *   - `entered`: each external stream ingressed (persistent) into the scope
 *   - `variables`: a feedback handle per named variable (starts empty;
 *                  body returns its new value)
 *
 * The body must return one stream per variable name (`results[name]`).
 * That stream is wired back as the variable's iteration-time value via a
 * `FeedbackOperator`. After the loop converges, each variable's egressed
 * stream is returned in the outer scope.
 */
export function iterateMulti<
  ExternalKeys extends string,
  VarKeys extends string,
  ExternalVals extends Record<ExternalKeys, unknown>,
  VarVals extends Record<VarKeys, unknown>,
>(
  graph: D2,
  externals: { [K in ExternalKeys]: IStreamBuilder<ExternalVals[K]> },
  variableNames: readonly VarKeys[],
  body: (
    entered: { [K in ExternalKeys]: IStreamBuilder<ExternalVals[K]> },
    variables: { [K in VarKeys]: IStreamBuilder<VarVals[K]> },
  ) => { [K in VarKeys]: IStreamBuilder<VarVals[K]> },
): { [K in VarKeys]: IStreamBuilder<VarVals[K]> } {
  // 1. Push the iteration scope.
  const newFrontier = graph.frontier().extend()
  graph.pushFrontier(newFrontier)

  // 2. Persistent-ingress every external stream.
  const entered = {} as { [K in ExternalKeys]: IStreamBuilder<ExternalVals[K]> }
  for (const name of Object.keys(externals) as ExternalKeys[]) {
    entered[name] = persistentIngress(externals[name]) as IStreamBuilder<ExternalVals[typeof name]>
  }

  // 3. Create N feedback variables. Each one is a `StreamBuilder` whose
  //    writer will be filled in by a `FeedbackOperator` after the body runs.
  const feedbackWriters = {} as { [K in VarKeys]: AnyWriter }
  const variables = {} as { [K in VarKeys]: IStreamBuilder<VarVals[K]> }
  for (const name of variableNames) {
    const writer = makeWriter<VarVals[typeof name]>(graph)
    feedbackWriters[name] = writer
    variables[name] = new StreamBuilder<VarVals[typeof name]>(graph, writer)
  }

  // 4. Run the body.
  const results = body(entered, variables)

  // 5. Wire each variable's feedback.
  for (const name of variableNames) {
    const result = results[name]
    const writer = feedbackWriters[name]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const feedbackOp = new (FeedbackOperator as any)(
      graph.getNextOperatorId(),
      result.connectReader(),
      1, // step
      writer,
      graph.frontier(),
    )
    graph.addStream(variables[name].connectReader())
    graph.addOperator(feedbackOp)
  }

  // 6. Pop the scope.
  graph.popFrontier()

  // 7. Egress each result back to the outer scope.
  const egressed = {} as { [K in VarKeys]: IStreamBuilder<VarVals[K]> }
  for (const name of variableNames) {
    egressed[name] = egressFrom(results[name])
  }
  return egressed
}
