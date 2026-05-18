// Port of flowlog/src/reading/src/session.rs
//
// Wraps a d2ts RootStreamBuilder + a buffer of pending updates, matching the
// shape of DD's `InputSession`. The Rust crate dispatches per-arity (Row<1>
// through Row<8> plus a FatRow variant); the TS port has a single class
// because `Row = bigint[]` covers all arities at once.

import type { MultiSet, RootStreamBuilder } from '@electric-sql/d2ts'
import { MultiSet as MultiSetClass } from '@electric-sql/d2ts'
import type { Row } from './row.js'
import type { Semiring } from './semiring.js'
import type { Time } from './epoch.js'

/**
 * Mirrors DD's `InputSession<Row, Semiring>`. Accumulate updates with
 * `update()`, then call `flush()` to send them to the underlying d2ts input,
 * or `advanceTo(time)` to flush and bump the frontier.
 */
export class InputSessionGeneric<T = Row> {
  private pending: Array<[T, Semiring]> = []
  private currentTime: Time = 0

  constructor(
    public readonly arity: number,
    private readonly input: RootStreamBuilder<T>,
  ) {}

  /** Buffer a row update with its diff. Doesn't push to d2ts until `flush()`. */
  update(row: T, diff: Semiring): void {
    this.pending.push([row, diff])
  }

  /** Flush pending updates at the current time. */
  flush(): void {
    if (this.pending.length === 0) return
    const ms = new MultiSetClass<T>(this.pending) as MultiSet<T>
    this.input.sendData(this.currentTime, ms)
    this.pending = []
  }

  /** Flush pending updates and advance the frontier to `time`. */
  advanceTo(time: Time): void {
    this.flush()
    this.input.sendFrontier(time)
    this.currentTime = time
  }

  /** Flush any pending updates and stop accepting new ones. */
  close(): void {
    this.flush()
  }

  /** Listen at the underlying stream (for direct d2ts operations). */
  listen(): RootStreamBuilder<T> {
    return this.input
  }
}
