// The dedup used *inside* a recursive scope.
//
// `stringDistinct` counts derivations: one multiplicity per value, present
// while that number is positive. Outside recursion that is exactly right.
// Inside it, it is the difference between an engine that retracts and one that
// only appears to.
//
// Transitive closure over `Arc(0,1), Arc(1,2), Arc(2,1)`: `T(0,1)` is derived
// twice, once from the base rule and once by going round the 1⇄2 loop, so its
// count is 2. Retract `Arc(0,1)` and the count falls to 1 — still positive, so
// nothing is emitted, so the cascade that should have unwound the loop never
// starts. `T(0,1)` and `T(0,2)` sit there holding each other up with nothing
// underneath them. The Rust engine describes the same failure as "a recursive
// fact that loses its only well-founded support (but retains circular support)
// is never retracted", and fixes it by keeping differential-dataflow's nested
// product timestamps and a dedup correct over that partial order.
//
// The timestamp is doing one job here: distinguishing a derivation that stands
// on its own from one that stands on the tuple it is justifying. That is a
// question about *well-foundedness*, and there is a way to answer it without
// carrying a time coordinate on every tuple — ask.
//
// So: on losing a derivation, retract optimistically, even though the count is
// still positive. The retraction propagates. If the surviving derivations were
// circular, they are built on the tuple just retracted and the cascade comes
// back round and removes them too — the count reaches zero and the tuple is
// correctly gone. If they were well founded, the cascade never touches them,
// the count is still positive when the graph settles, and the tuple goes
// straight back. Delete, then re-derive: the loop itself distinguishes the two
// cases, because propagating the deletion is exactly the experiment that
// separates them.
//
// That is DRed (Gupta, Mumick & Subrahmanian), arranged so the dataflow does
// the work. `D2.run` provides the second half by running to a fixpoint, giving
// operators a chance to `settle()`, and running again until nothing more is
// deferred. Re-derivation only ever adds — a recursive stratum cannot contain
// negation — so it terminates, bounded by the fixpoint that existed before.
//
// The cost is paid only where a retraction actually lands: a tuple whose count
// merely *rose* takes the ordinary path, and a tuple nothing touched is never
// looked at. What it costs when it does land is a retract/re-assert pair
// through whatever the tuple feeds, which is the price of not knowing whether
// support is circular until you pull on it.

import { DifferenceStreamWriter, UnaryOperator } from '../graph.js'
import { StreamBuilder } from '../d2.js'
import { MultiSet } from '../multiset.js'
import type { DifferenceStreamReader } from '../graph.js'
import type { IStreamBuilder, PipedOperator } from '../types.js'

export class RecursiveStringDistinctOperator extends UnaryOperator<string> {
  /** Derivation count, exactly as `stringDistinct` keeps it. */
  readonly #count = new Map<string, number>()
  /** What has been emitted as present, so the output is a diff and not a state. */
  readonly #present = new Set<string>()
  /** Retracted on suspicion of having lost its only well-founded support, and
   *  owed a second look once the retraction has finished propagating. */
  readonly #suspect = new Set<string>()
  /** Assertions held back so they cannot cancel against the retractions going
   *  out in the same breath. See the note in `run`. */
  readonly #held: Array<[string, number]> = []

  run(): void {
    if (this.inputs[0]!.isEmpty()) return

    // Net *and* whether anything was taken away. Netting alone hides the case
    // this operator exists for: a tick that both retracts a derivation and adds
    // one nets to zero, and the one it added can be circular. Suspicion has to
    // be raised by the retraction, not by the balance.
    const tick = new Map<string, number>()
    const lost = new Set<string>()
    for (const message of this.inputMessages() as Array<MultiSet<string>>) {
      const inner = message.getInner()
      for (let i = 0; i < inner.length; i++) {
        const entry = inner[i]!
        tick.set(entry[0], (tick.get(entry[0]) ?? 0) + entry[1])
        if (entry[1] < 0) lost.add(entry[0])
      }
    }

    const result: Array<[string, number]> = []
    for (const [value, delta] of tick) {
      const before = this.#count.get(value) ?? 0
      const after = before + delta
      if (after === 0) this.#count.delete(value)
      else this.#count.set(value, after)

      if (after <= 0) {
        // Gone outright. Nothing to re-derive and nothing to wonder about.
        this.#suspect.delete(value)
        if (this.#present.has(value)) {
          this.#present.delete(value)
          result.push([value, -1])
        }
        continue
      }

      // A verdict is already pending, and this delta is part of the cascade
      // that will decide it. Re-asserting now on a still-positive count is
      // exactly the mistake being tested for — the cascade coming back round
      // to knock another derivation off a suspect tuple would look, here, like
      // a tuple that had been counted all along.
      if (this.#suspect.has(value)) continue

      if (lost.has(value) && this.#present.has(value)) {
        // Still counted, but one of the things counting it has gone. Whether
        // the rest are real or are leaning on this very tuple is not knowable
        // here, so assume the worst and let the cascade answer.
        this.#present.delete(value)
        this.#suspect.add(value)
        result.push([value, -1])
        continue
      }

      if (!this.#present.has(value)) {
        this.#present.add(value)
        result.push([value, 1])
      }
    }

    // A batch carrying both signs is the one thing that must not leave here
    // together. A join downstream sees `-A` and `+B`, produces the loss of a
    // derivation of C and the arrival of a replacement, and the two cancel
    // inside one message — after which nothing records that C's support was
    // swapped for one that might be leaning on C itself. Retractions go now;
    // assertions wait until the retraction has finished propagating, which is
    // the same moment a suspect gets its verdict.
    //
    // Only when both signs are present. A batch of one sign — every load, and
    // most edits — goes out whole, so the loop keeps its usual number of passes.
    const negatives: Array<[string, number]> = []
    let positives = 0
    for (const entry of result) {
      if (entry[1] < 0) negatives.push(entry)
      else positives++
    }
    if (negatives.length > 0 && positives > 0) {
      for (const entry of result) if (entry[1] > 0) this.#held.push(entry)
      this.output.sendData(new MultiSet(negatives))
      return
    }
    if (result.length > 0) this.output.sendData(new MultiSet(result))
  }

  /** The re-derive half. Anything still counted once the retraction has stopped
   *  propagating was standing on its own after all. */
  settle(): boolean {
    if (this.#suspect.size === 0 && this.#held.length === 0) return false
    const result: Array<[string, number]> = []
    for (const value of this.#suspect) {
      if ((this.#count.get(value) ?? 0) <= 0) continue
      this.#present.add(value)
      result.push([value, 1])
    }
    this.#suspect.clear()
    // Both halves are assertions, so releasing them together is safe — it is
    // only against a retraction that they could cancel.
    result.push(...this.#held)
    this.#held.length = 0
    if (result.length === 0) return false
    this.output.sendData(new MultiSet(result))
    return true
  }

  // Deliberately no `hasPendingWork` override. A suspect is resolved by
  // `settle()`, not by `run()`, so reporting it as pending work would spin the
  // `while (pendingWork()) step()` loop that has to *finish* before settling is
  // meaningful — the cascade is the evidence being waited on.
}

/** Set-semantics dedup for a stream of primitive strings inside a recursive
 *  scope, where a tuple can be counted by its own descendants and so cannot be
 *  trusted to a reference count alone. Outside recursion `stringDistinct` is
 *  the cheaper and equivalent choice. */
export function recursiveStringDistinct(): PipedOperator<string, string> {
  return (stream) => {
    const output = new StreamBuilder<string>(
      stream.graph,
      new DifferenceStreamWriter<string>(),
    )
    const operator = new RecursiveStringDistinctOperator(
      stream.graph.getNextOperatorId(),
      stream.connectReader() as DifferenceStreamReader<string>,
      output.writer,
    )
    stream.graph.addOperator(operator)
    return output
  }
}
