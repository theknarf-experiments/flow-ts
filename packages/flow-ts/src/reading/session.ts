// Port of flowlog/src/reading/src/session.rs
//
// Wraps a db-ivm RootStreamBuilder + a buffer of pending updates, matching
// the shape of DD's `InputSession`. The Rust crate dispatches per-arity
// (Row<1>..Row<8> + FatRow); the TS port has a single class because
// `Row = bigint[]` covers all arities at once. db-ivm has no notion of
// frontiers or epoch, so `advanceTo()` is just an alias for `flush()`.

import type { MultiSet, RootStreamBuilder } from '@flow-ts/db-ivm'
import { MultiSet as MultiSetClass } from '@flow-ts/db-ivm'
import type { Row } from './row.js'
import type { Semiring } from './semiring.js'
import type { Time } from './epoch.js'

/**
 * Buffer updates and push them to the underlying db-ivm input as one batch.
 */
export class InputSessionGeneric<T = Row> {
  private pending: Array<[T, Semiring]> = []

  constructor(
    public readonly arity: number,
    private readonly input: RootStreamBuilder<T>,
  ) {}

  /** Buffer a row update with its diff. Doesn't push to db-ivm until `flush()`. */
  update(row: T, diff: Semiring): void {
    this.pending.push([row, diff])
  }

  /** Flush pending updates. */
  flush(): void {
    if (this.pending.length === 0) return
    const ms = new MultiSetClass<T>(this.pending) as MultiSet<T>
    this.input.sendData(ms)
    this.pending = []
  }

  /** Flush pending updates. The `time` argument is retained for API
   * compatibility with the Rust DD port and is ignored. */
  advanceTo(_time: Time): void {
    this.flush()
  }

  /** Flush any pending updates and stop accepting new ones. */
  close(): void {
    this.flush()
  }

  /** Listen at the underlying stream (for direct db-ivm operations). */
  listen(): RootStreamBuilder<T> {
    return this.input
  }
}
