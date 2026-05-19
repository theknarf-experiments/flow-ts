// Port of flowlog/src/executing/src/dataflow.rs (incremental).
//
// Builds a d2ts dataflow graph from a parsed Program + caller-provided EDB
// facts, runs the graph, and surfaces IDB results via a sink callback.
// No filesystem access here — the CLI package owns CSV reading and writing.
//
// Encoding strategy:
//   - Row streams:    `IStreamBuilder<string>`             (encoded row)
//   - Keyed streams:  `IStreamBuilder<[string, string]>`   (encoded key, encoded value)
//   - K-only streams: `IStreamBuilder<string>`             (encoded row == key)
//
// String encoding sidesteps d2ts's two limitations on bigint-bearing
// row arrays (JS Map identity + JSON.stringify in delta tracking).
//
// **Status**: handles single- and multi-IDB strata with the common
// transformation kinds (RowTo*/KvTo*/Jn*/Nj*/Cartesian), constraint
// filtering, fused compare filtering, prior-stratum intermediates in
// any form, head arithmetic via the planner's HeadArith post-map, and
// non-recursive aggregation (Min/Max/Sum/Count, grouped by all-but-last
// columns). Recursive aggregation reuses the same reducer per iteration;
// only Min is guaranteed to converge monotonically. Recursions whose
// dataflow cycle passes through 3+ mutually-dependent IDBs hit a d2ts
// FeedbackOperator frontier-convergence limitation (cspa/cvc5/galen/z3).

import {
  D2,
  type IStreamBuilder,
  type KeyValue,
  type RootStreamBuilder,
  antiJoin,
  concat,
  distinct,
  filter,
  innerJoin,
  iterate,
  map,
  output,
  reduce,
} from '@flow-ts/db-ivm'
import { iterateMulti } from './iterate-multi.js'
import {
  type AggregationHeadIDB,
  aggregationCatalogFromProgram,
} from '@flow-ts/catalog'
import type { Program } from '@flow-ts/parsing'
import {
  type BinaryTransformation,
  type GroupStrataQueryPlan,
  type ProgramQueryPlan,
  ProgramQueryPlan as ProgramQueryPlanCls,
  type Transformation,
  type TransformationFlow,
  binaryInputs,
  isUnary,
  transformationOutput,
  unaryInput,
} from '@flow-ts/planning'
import { type Row, decodeRow, encodeRow } from '@flow-ts/reading'
import { Strata } from '@flow-ts/strata'

export type IdbSink = (relationName: string, row: Row, diff: number) => void

type EncodedRow = string
type EncodedKv = KeyValue<string, string>

interface DataflowMaps {
  /** Row-form streams: signature name → encoded-row stream. */
  rowMap: Map<string, IStreamBuilder<EncodedRow>>
  /** Keyed (k, v) streams: signature name → encoded-kv stream. */
  kvMap: Map<string, IStreamBuilder<EncodedKv>>
  /** Key-only streams: signature name → encoded-row stream (the row IS the key). */
  kMap: Map<string, IStreamBuilder<EncodedRow>>
}

export interface ExecuteOptions {
  /** Disables transformation-output sharing across rules — matches `--no-sharing`. */
  noSharing?: boolean
  /** Optimizer level; null = passthrough, 1 = sip, 2 = planning, 3 = both. */
  optLevel?: number | null
}

/**
 * Compile and run a parsed program against the supplied EDB facts. Each
 * row produced by an IDB head is delivered to `sink`. The function is
 * synchronous and finishes once the graph reaches its fixpoint.
 *
 * @param program     A program already parsed via `parseProgram`.
 * @param edbFacts    Map from EDB declaration name → rows of bigints. Any
 *                    EDB referenced by the program but missing from the map
 *                    is treated as empty.
 * @param options     Optional tuning knobs (see `ExecuteOptions`).
 * @param sink        Callback invoked once per (relation, row, multiplicity).
 */
/**
 * A long-lived incremental query session. db-ivm operators maintain
 * state across `D2.run()` calls, so each `advance()` only processes the
 * EDB delta queued since the previous advance. The `sink` callback fires
 * with each new IDB diff during `advance()`.
 *
 * Lifecycle: build session → `update(rel, row, ±1)` repeatedly →
 * `advance()` to drive the graph → optionally more updates → finally
 * `close()` (or just keep advancing indefinitely).
 */
export interface ProgramSession {
  /** Queue an EDB delta. `diff` defaults to +1 (insert); -1 retracts.
   *  Multiple updates for the same row accumulate via the standard
   *  multiset arithmetic. Calling `update` after `close` throws. */
  update(relation: string, row: Row, diff?: number): void
  /** Flush queued updates, drive the graph to a fixpoint over them. */
  advance(): void
  /** Final advance + freeze the session. Further updates throw. */
  close(): void
}

/**
 * Open a streaming session over the given program. `executeProgram` is a
 * thin convenience wrapper that loads all EDB facts and closes the
 * session in one shot.
 */
export function openSession(
  program: Program,
  options: ExecuteOptions,
  sink: IdbSink,
): ProgramSession {
  const strata = Strata.fromParser(program)
  const plan = ProgramQueryPlanCls.fromStrata(
    strata,
    options.noSharing ?? false,
    options.optLevel ?? null,
  )
  const aggCatalog = aggregationCatalogFromProgram(program)

  const graph = new D2()

  const maps: DataflowMaps = {
    rowMap: new Map(),
    kvMap: new Map(),
    kMap: new Map(),
  }

  const edbInputs = new Map<string, RootStreamBuilder<EncodedRow>>()
  for (const edb of program.edbs) {
    const input = graph.newInput<EncodedRow>()
    edbInputs.set(edb.name, input)
    maps.rowMap.set(edb.name, input)
  }

  buildProgramDataflow(
    graph,
    plan,
    maps,
    sink,
    new Set(program.idbs.map((d) => d.name)),
    aggCatalog,
  )

  graph.finalize()

  // Per-EDB queue of (encoded row, diff) waiting to be sent at next advance.
  const pending = new Map<string, Array<[EncodedRow, number]>>()
  let closed = false

  return {
    update(relation, row, diff = 1) {
      if (closed) throw new Error('session closed')
      if (!edbInputs.has(relation)) {
        throw new Error(`unknown EDB relation: ${relation}`)
      }
      let queue = pending.get(relation)
      if (!queue) {
        queue = []
        pending.set(relation, queue)
      }
      queue.push([encodeRow(row), diff])
    },
    advance() {
      if (closed) throw new Error('session closed')
      for (const [relation, queue] of pending) {
        if (queue.length === 0) continue
        edbInputs.get(relation)!.sendData(queue)
      }
      pending.clear()
      graph.run()
    },
    close() {
      if (closed) return
      this.advance()
      closed = true
    },
  }
}

/**
 * Batch-mode helper. Loads all EDB facts and runs the program once to a
 * fixpoint. Internally a thin wrapper around `openSession`.
 */
export function executeProgram(
  program: Program,
  edbFacts: ReadonlyMap<string, readonly Row[]>,
  options: ExecuteOptions,
  sink: IdbSink,
): void {
  const session = openSession(program, options, sink)
  for (const [relation, rows] of edbFacts) {
    for (const row of rows) session.update(relation, row, 1)
  }
  session.close()
}

function buildProgramDataflow(
  graph: D2,
  plan: ProgramQueryPlan,
  maps: DataflowMaps,
  sink: IdbSink,
  idbSet: ReadonlySet<string>,
  aggCatalog: ReadonlyMap<string, AggregationHeadIDB>,
): void {
  for (const groupPlan of plan.programPlan) {
    if (groupPlan.isRecursive) {
      buildRecursiveStratum(graph, groupPlan, maps, aggCatalog)
    } else {
      buildNonRecursiveStratum(groupPlan, maps, aggCatalog)
    }
  }
  // Sink each IDB head's final stream after all strata are processed. This
  // way, a head produced by both a non-recursive and a recursive stratum
  // (the reach.dl pattern) only sinks the converged recursive result.
  for (const idbName of idbSet) {
    const stream = maps.rowMap.get(idbName)
    if (!stream) continue
    stream.pipe(
      output((data) => {
        for (const [encoded, mult] of data.getInner()) {
          sink(idbName, decodeRow(encoded), mult)
        }
      }),
    )
  }
}

function buildNonRecursiveStratum(
  groupPlan: GroupStrataQueryPlan,
  maps: DataflowMaps,
  aggCatalog: ReadonlyMap<string, AggregationHeadIDB>,
): void {
  for (const t of groupPlan.strataPlanFlat()) {
    applyTransformation(t, maps, groupPlan)
  }
  registerHeads(groupPlan, maps, aggCatalog)
}

/**
 * After a stratum's transformations are wired, populate `maps.rowMap[head]`
 * for every IDB head it produces — the union of all rules' last outputs,
 * deduped (or aggregated). Subsequent strata can then reference the head
 * as a base atom.
 *
 * A predicate may appear as a head in multiple non-recursive strata when
 * Kosaraju puts its rules in independent SCCs (e.g. Doop's `SubtypeOf` —
 * leaf-projection rules sit in one stratum, IDB-join rules in another).
 * When that happens we union the new stratum's outputs with whatever is
 * already in `rowMap[head]` so downstream consumers see all contributions.
 */
function registerHeads(
  groupPlan: GroupStrataQueryPlan,
  maps: DataflowMaps,
  aggCatalog: ReadonlyMap<string, AggregationHeadIDB>,
): void {
  for (const [headName, lasts] of groupPlan.lastSignaturesMap) {
    let unioned: IStreamBuilder<EncodedRow> | null = maps.rowMap.get(headName) ?? null
    for (const last of lasts) {
      const s = maps.rowMap.get(last)
      if (!s) continue
      unioned = unioned === null ? s : unioned.pipe(concat(s))
    }
    if (unioned === null) continue
    const aggHead = aggCatalog.get(headName)
    maps.rowMap.set(
      headName,
      aggHead ? applyAggregation(unioned, aggHead) : dedupeEncodedRows(unioned),
    )
  }
}

/**
 * Recursive stratum executor (db-ivm). One feedback variable per IDB
 * head. db-ivm operators carry their own state across `run()` calls, so
 * externals (EDBs / prior-stratum IDBs) don't need a scope wrapper —
 * they're just read from `maps.*` inside the body's closure and the
 * downstream join/distinct operators remember everything they've seen.
 *
 * Each iteration the body unions all per-rule contributions + any prior-
 * stratum value for the head, then deduplicates (or aggregates) before
 * handing the result to `iterateMulti`, which forwards it as the
 * variable's next value and also surfaces it as the converged output.
 */
function buildRecursiveStratum(
  graph: D2,
  groupPlan: GroupStrataQueryPlan,
  maps: DataflowMaps,
  aggCatalog: ReadonlyMap<string, AggregationHeadIDB>,
): void {
  const heads = [...groupPlan.headSignaturesSet()]
  if (heads.length === 0) return

  // Snapshot the prior-stratum head streams BEFORE we install variable
  // placeholders so the body can concat them with the per-rule outputs.
  // (Mirrors Rust's `recursive_collector` seeding with `init_rel`.)
  const priors = new Map<string, IStreamBuilder<EncodedRow>>()
  for (const headName of heads) {
    const prior = maps.rowMap.get(headName)
    if (prior) priors.set(headName, prior)
  }

  const results = iterateMulti<string, Record<string, EncodedRow>>(
    graph,
    heads,
    (variables) => {
      // The body sees a nested view of `maps` where each recursive head
      // is replaced by its variable handle. Externals (EDBs, prior-
      // stratum non-head IDBs) keep pointing at the outer streams.
      const nestMaps: DataflowMaps = {
        rowMap: new Map(maps.rowMap),
        kvMap: new Map(maps.kvMap),
        kMap: new Map(maps.kMap),
      }
      for (const h of heads) {
        nestMaps.rowMap.set(h, variables[h]! as IStreamBuilder<EncodedRow>)
      }

      for (const t of groupPlan.strataPlanFlat()) {
        applyTransformation(t, nestMaps, groupPlan)
      }

      const out: Record<string, IStreamBuilder<EncodedRow>> = {}
      for (const headName of heads) {
        const lasts = groupPlan.lastSignaturesMap.get(headName) ?? []
        let unioned: IStreamBuilder<EncodedRow> | null = null
        for (const last of lasts) {
          const s = nestMaps.rowMap.get(last)
          if (!s) continue
          unioned = unioned === null ? s : unioned.pipe(concat(s))
        }
        const prior = priors.get(headName)
        if (prior) {
          unioned = unioned === null ? prior : unioned.pipe(concat(prior))
        }
        const headVar = variables[headName]! as IStreamBuilder<EncodedRow>
        if (unioned === null) {
          out[headName] = headVar.pipe(filter(() => false))
          continue
        }
        const aggHead = aggCatalog.get(headName)
        out[headName] = aggHead
          ? applyAggregation(unioned, aggHead)
          : dedupeEncodedRows(unioned)
      }
      return out
    },
  )

  for (const headName of heads) {
    const finalHead = results[headName]
    if (finalHead) maps.rowMap.set(headName, finalHead as IStreamBuilder<EncodedRow>)
  }
}

/**
 * Group an encoded-row stream by all-but-last columns and apply the head's
 * aggregation operator to the last column. Output rows are the group key
 * followed by the aggregated scalar — the analog of Rust's
 * `aggregation_reduce_logic` + `aggregation_merge_kv`.
 *
 * Only the all-positive numeric path is wired up: Min/Max/Sum/Count over
 * a single bigint column. Compatible with the planner's `HeadArith`
 * post-map (which copies the aggregation's first var into the last slot).
 */
function applyAggregation(
  stream: IStreamBuilder<EncodedRow>,
  aggHead: AggregationHeadIDB,
): IStreamBuilder<EncodedRow> {
  const operator = aggHead.aggregationArgument.operator
  // arity = group-cols + 1 (the agg-value). isGroupBy = arity > 1.
  // Re-key to [encoded_group_key, encoded_agg_value] for d2ts `reduce`.
  const keyed = stream.pipe(
    map((encoded): EncodedKv => {
      const row = decodeRow(encoded)
      const k = row.slice(0, row.length - 1)
      const v = row.slice(row.length - 1)
      return [encodeRow(k), encodeRow(v)]
    }),
  )
  return keyed
    .pipe(
      reduce((vals: [string, number][]): [string, number][] => {
        // Multiply each value by its multiplicity for Sum/Count semantics.
        // Min/Max ignore multiplicity (idempotent over a set).
        let acc: number | null = null
        let count = 0
        for (const [encV, mult] of vals) {
          if (mult <= 0) continue
          const v = decodeRow(encV)[0]!
          for (let i = 0; i < mult; i++) {
            switch (operator) {
              case 'Min':
                acc = acc === null || v < acc ? v : acc
                break
              case 'Max':
                acc = acc === null || v > acc ? v : acc
                break
              case 'Sum':
                acc = (acc ?? 0) + v
                break
              case 'Count':
                count += 1
                break
            }
          }
        }
        const result: number =
          operator === 'Count' ? count : acc !== null ? acc : 0
        if (operator !== 'Count' && acc === null) return []
        return [[encodeRow([result]), 1]]
      }),
    )
    .pipe(
      map(([encK, encV]) => {
        const k = decodeRow(encK)
        const v = decodeRow(encV)
        return encodeRow([...k, ...v])
      }),
    )
}

/** Dedupe an encoded-row stream (matches reading's dedupeRowStream). */
function dedupeEncodedRows(
  stream: IStreamBuilder<EncodedRow>,
): IStreamBuilder<EncodedRow> {
  return stream.pipe(
    map((r) => [r, r] as [string, string]),
    distinct(),
    map(([, v]) => v as string),
  )
}

// -----------------------------------------------------------------------
// Per-transformation translation
// -----------------------------------------------------------------------

function applyTransformation(
  t: Transformation,
  maps: DataflowMaps,
  groupPlan?: GroupStrataQueryPlan,
): void {
  const outName = transformationOutput(t).signature.name
  if (isUnary(t)) {
    applyUnary(t, maps, outName)
  } else {
    applyBinary(t, maps, outName)
  }
  // Inside a recursive stratum, SIP rules generate `_sip` heads that later
  // rules in the SAME iteration reference by short name. `registerHeads`
  // only runs at stratum boundaries, so we alias the short name to the
  // last-transformation stream right here. Non-recursive strata don't
  // need this — the collector at the end (`registerHeads`) handles all
  // head registration in one pass, and aliasing here would double-count
  // when sharing dedupes the transformation across mini-strata.
  if (groupPlan?.isRecursive) {
    const heads = groupPlan.reverseLastSignaturesMap.get(outName)
    if (heads) {
      for (const head of heads) {
        if (!head.includes('_sip')) continue
        const s = maps.rowMap.get(outName)
        if (s) maps.rowMap.set(head, s)
        const k = maps.kMap.get(outName)
        if (k) maps.kMap.set(head, k)
        const kv = maps.kvMap.get(outName)
        if (kv) maps.kvMap.set(head, kv)
      }
    }
  }
}

function applyUnary(
  t: Transformation,
  maps: DataflowMaps,
  outName: string,
): void {
  const inputName = unaryInput(t).signature.name
  switch (t.kind) {
    case 'RowToRow': {
      const stream = requireRow(maps, inputName, t.kind)
      if (t.isNoOp) {
        maps.rowMap.set(outName, stream)
        return
      }
      const fn = makeRowToRowFn(t.flow)
      maps.rowMap.set(outName, stream.pipe(filterMap(fn)))
      return
    }
    case 'RowToK': {
      const stream = requireRow(maps, inputName, t.kind)
      if (t.isNoOp) {
        maps.kMap.set(outName, stream)
        return
      }
      const fn = makeRowToRowFn(t.flow)
      maps.kMap.set(outName, stream.pipe(filterMap(fn)))
      return
    }
    case 'RowToKv': {
      const stream = requireRow(maps, inputName, t.kind)
      const fn = makeRowToKvFn(t.flow)
      maps.kvMap.set(outName, stream.pipe(filterMap(fn)))
      return
    }
    case 'KvToKv': {
      const stream = requireKv(maps, inputName, t.kind)
      const fn = makeKvToKvFn(t.flow)
      maps.kvMap.set(outName, stream.pipe(filterMap(fn)))
      return
    }
    case 'KvToK': {
      const stream = requireKv(maps, inputName, t.kind)
      const fn = makeKvToKFn(t.flow)
      maps.kMap.set(outName, stream.pipe(filterMap(fn)))
      return
    }
    default:
      throw new Error(`applyUnary: unexpected kind ${(t as { kind: string }).kind}`)
  }
}

function applyBinary(
  t: Transformation,
  maps: DataflowMaps,
  outName: string,
): void {
  const binary = t as BinaryTransformation
  const [left, right] = binaryInputs(binary)
  const leftName = left.signature.name
  const rightName = right.signature.name

  const outRel = transformationOutput(binary)
  const [ok, ov] = outRel.arity()

  // Pull left/right streams into a uniform `[K, V]` shape so we can use
  // d2ts innerJoin / antiJoin uniformly.
  let leftKv: IStreamBuilder<EncodedKv>
  let rightKv: IStreamBuilder<EncodedKv>

  switch (binary.kind) {
    case 'JnKvKv':
    case 'NjKvK': {
      leftKv = requireKv(maps, leftName, binary.kind)
      rightKv =
        binary.kind === 'NjKvK'
          ? keyOnlyToKv(requireK(maps, rightName, binary.kind))
          : requireKv(maps, rightName, binary.kind)
      break
    }
    case 'JnKvK': {
      leftKv = requireKv(maps, leftName, binary.kind)
      rightKv = keyOnlyToKv(requireK(maps, rightName, binary.kind))
      break
    }
    case 'JnKKv': {
      leftKv = keyOnlyToKv(requireK(maps, leftName, binary.kind))
      rightKv = requireKv(maps, rightName, binary.kind)
      break
    }
    case 'JnKK':
    case 'NjKK': {
      leftKv = keyOnlyToKv(requireK(maps, leftName, binary.kind))
      rightKv = keyOnlyToKv(requireK(maps, rightName, binary.kind))
      break
    }
    case 'Cartesian': {
      // Cartesian: re-key everything under a single sentinel and join.
      const leftRow = requireRow(maps, leftName, binary.kind)
      const rightRow = requireRow(maps, rightName, binary.kind)
      leftKv = leftRow.pipe(map((r) => ['', r] as EncodedKv))
      rightKv = rightRow.pipe(map((r) => ['', r] as EncodedKv))
      break
    }
    default: {
      const exhaustive: never = binary
      throw new Error(
        `applyBinary: unexpected kind ${(exhaustive as { kind: string }).kind}`,
      )
    }
  }

  if (binary.kind === 'NjKvK' || binary.kind === 'NjKK') {
    const joined = leftKv.pipe(antiJoin(rightKv))
    // antiJoin gives [K, [V, null]] — only left rows survive. Project to output.
    const fn = makeAntijoinOutFn(binary.flow, ok, ov)
    storeBinaryResult(maps, outName, joined, fn, ok, ov)
    return
  }

  // innerJoin produces [K, [V1, V2]].
  const joined = leftKv.pipe(innerJoin(rightKv))
  const fn = makeJoinOutFn(binary.flow, ok, ov)
  storeBinaryResult(maps, outName, joined, fn, ok, ov)
}

function storeBinaryResult<JoinOut>(
  maps: DataflowMaps,
  outName: string,
  joined: IStreamBuilder<JoinOut>,
  fn: (j: JoinOut) => { key: string; value: string } | null,
  ok: number,
  ov: number,
): void {
  // Filter out rows the projection function rejects (fused compare filters
  // returning null), then project. Two passes via filter+map; fn is called
  // twice per row, but that's acceptable.
  const surviving = joined.pipe(filter((j) => fn(j) !== null))
  if (ok === 0) {
    // row form: encoded value is the whole row
    const out = surviving.pipe(map((j) => fn(j)!.value))
    maps.rowMap.set(outName, out)
  } else if (ov === 0) {
    // k-only form: encoded key is the whole row
    const out = surviving.pipe(map((j) => fn(j)!.key))
    maps.kMap.set(outName, out)
  } else {
    // kv form
    const out = surviving.pipe(map((j): EncodedKv => {
      const r = fn(j)!
      return [r.key, r.value]
    }))
    maps.kvMap.set(outName, out)
  }
}

function requireRow(
  maps: DataflowMaps,
  name: string,
  ctx: string,
): IStreamBuilder<EncodedRow> {
  const s = maps.rowMap.get(name)
  if (!s) throw new Error(`${ctx}: row stream not found for "${name}"`)
  return s
}

function requireKv(
  maps: DataflowMaps,
  name: string,
  ctx: string,
): IStreamBuilder<EncodedKv> {
  const s = maps.kvMap.get(name)
  if (!s) throw new Error(`${ctx}: kv stream not found for "${name}"`)
  return s
}

function requireK(
  maps: DataflowMaps,
  name: string,
  ctx: string,
): IStreamBuilder<EncodedRow> {
  const s = maps.kMap.get(name)
  if (!s) throw new Error(`${ctx}: k stream not found for "${name}"`)
  return s
}

function keyOnlyToKv(
  stream: IStreamBuilder<EncodedRow>,
): IStreamBuilder<EncodedKv> {
  return stream.pipe(map((r) => [r, ''] as EncodedKv))
}

/** Convenience: filter+map combined via the d2ts `filter` then `map`. */
function filterMap<I, O>(fn: (input: I) => O | null) {
  return (stream: IStreamBuilder<I>): IStreamBuilder<O> =>
    stream.pipe(
      filter((x) => fn(x) !== null),
      map((x) => fn(x) as O),
    )
}

// -----------------------------------------------------------------------
// Flow evaluation: read positions, evaluate constraints + comparisons
// -----------------------------------------------------------------------

type TArg = import('@flow-ts/planning').TransformationArgument
type FactorArg = import('@flow-ts/planning').FactorArgument
type ArithArg = import('@flow-ts/planning').ArithmeticArgument
type CompareArg = import('@flow-ts/planning').ComparisonExprArgument
type BaseConstraintsT = import('@flow-ts/planning').BaseConstraints

/** Resolves a TransformationArgument to its concrete numeric value. */
type ArgReader = (arg: TArg) => number

/** Reader for KV-form inputs (one keyed pair). */
function kvReader(key: readonly number[], value: readonly number[]): ArgReader {
  return (arg) => {
    if (arg.kind !== 'KV') throw new Error(`kvReader: expected KV arg, got ${arg.kind}`)
    const arr = arg.isValue ? value : key
    const v = arr[arg.id]
    if (v === undefined) throw new Error(`kvReader: out-of-range id ${arg.id}`)
    return v
  }
}

/** Reader for join-output inputs: shared key, left value, right value. */
function jnReader(
  key: readonly number[],
  leftValue: readonly number[],
  rightValue: readonly number[],
): ArgReader {
  return (arg) => {
    if (arg.kind !== 'Jn') throw new Error(`jnReader: expected Jn arg, got ${arg.kind}`)
    if (!arg.isValue) {
      const v = key[arg.id]
      if (v === undefined) throw new Error(`jnReader: out-of-range key id ${arg.id}`)
      return v
    }
    const side = arg.isRight ? rightValue : leftValue
    const v = side[arg.id]
    if (v === undefined) throw new Error(`jnReader: out-of-range value id ${arg.id}`)
    return v
  }
}

function constToNumber(c: import('@flow-ts/parsing').Const): number {
  if (c.kind === 'Integer') return c.value
  if (c.kind === 'Float') {
    const buf = new ArrayBuffer(8)
    new BigInt64Array(buf)[0] = c.bits
    return new Float64Array(buf)[0]!
  }
  throw new Error(`constToNumber: ${c.kind} constants not yet supported`)
}

function evalFactor(f: FactorArg, read: ArgReader): number {
  return f.kind === 'Const' ? constToNumber(f.value) : read(f.argument)
}

function evalArith(arith: ArithArg, read: ArgReader): number {
  let acc = evalFactor(arith.init, read)
  for (const [op, factor] of arith.rest) {
    const x = evalFactor(factor, read)
    switch (op) {
      case 'Plus':    acc = acc + x; break
      case 'Minus':   acc = acc - x; break
      case 'Multiply':acc = acc * x; break
      case 'Divide':  acc = Math.trunc(acc / x); break
      case 'Modulo':  acc = acc % x; break
    }
  }
  return acc
}

function evalCompare(cmp: CompareArg, read: ArgReader): boolean {
  const l = evalArith(cmp.left, read)
  const r = evalArith(cmp.right, read)
  switch (cmp.operator) {
    case 'Equals':           return l === r
    case 'NotEquals':        return l !== r
    case 'GreaterThan':      return l > r
    case 'GreaterEqualThan': return l >= r
    case 'LessThan':         return l < r
    case 'LessEqualThan':    return l <= r
  }
}

function passesFilters(
  constraints: BaseConstraintsT,
  compares: readonly CompareArg[],
  read: ArgReader,
): boolean {
  for (const [arg, c] of constraints.constantEqConstraints) {
    if (read(arg) !== constToNumber(c)) return false
  }
  for (const [a, b] of constraints.variableEqConstraints) {
    if (read(a) !== read(b)) return false
  }
  for (const cmp of compares) {
    if (!evalCompare(cmp, read)) return false
  }
  return true
}

// -----------------------------------------------------------------------
// Flow → projection-function builders
// -----------------------------------------------------------------------

const EMPTY_KEY: readonly number[] = []

function requireKvFlow(
  flow: TransformationFlow,
  ctx: string,
): Extract<TransformationFlow, { kind: 'KVToKV' }> {
  if (flow.kind !== 'KVToKV') {
    throw new Error(`${ctx}: expected KVToKV flow, got ${flow.kind}`)
  }
  return flow
}

function projectionIds(
  args: readonly import('@flow-ts/planning').TransformationArgument[],
  ctx: string,
): [boolean, number][] {
  return args.map((a) => {
    if (a.kind !== 'KV') throw new Error(`${ctx}: expected KV arg, got ${a.kind}`)
    return [a.isValue, a.id] as [boolean, number]
  })
}

function makeRowToRowFn(flow: TransformationFlow): (encoded: string) => string | null {
  if (flow.kind === 'HeadArith') {
    // Post-projection map: each output column is either a Copy of an input
    // position or a Compute of an arithmetic over input positions.
    const projections = flow.projections
    return (encoded) => {
      const row = decodeRow(encoded)
      const read = kvReader(EMPTY_KEY, row)
      const out: number[] = projections.map((p) =>
        p.kind === 'Copy' ? row[p.index]! : evalArith(p.arithmetic, read),
      )
      return encodeRow(out)
    }
  }
  const kv = requireKvFlow(flow, 'makeRowToRowFn')
  // For RowToRow / RowToK, exactly one of `key`/`value` is populated.
  // The input is row-form (no key, value = the row).
  const proj = projectionIds(kv.key.length === 0 ? kv.value : kv.key, 'makeRowToRowFn')
  const constraints = kv.constraints
  const compares = kv.compares
  const unfiltered = constraints.isEmpty() && compares.length === 0
  if (unfiltered) {
    return (encoded) => pickEncodedRow(proj, splitEncoded(encoded))
  }
  return (encoded) => {
    const row = decodeRow(encoded)
    if (!passesFilters(constraints, compares, kvReader(EMPTY_KEY, row))) return null
    return encodeRow(proj.map(([_, id]) => row[id]!))
  }
}

function makeRowToKvFn(
  flow: TransformationFlow,
): (encoded: string) => EncodedKv | null {
  const kv = requireKvFlow(flow, 'makeRowToKvFn')
  const keyProj = projectionIds(kv.key, 'makeRowToKvFn key')
  const valProj = projectionIds(kv.value, 'makeRowToKvFn value')
  const constraints = kv.constraints
  const compares = kv.compares
  const unfiltered = constraints.isEmpty() && compares.length === 0
  if (unfiltered) {
    return (encoded) => {
      const cols = splitEncoded(encoded)
      return [pickEncodedRow(keyProj, cols), pickEncodedRow(valProj, cols)]
    }
  }
  return (encoded) => {
    const row = decodeRow(encoded)
    if (!passesFilters(constraints, compares, kvReader(EMPTY_KEY, row))) return null
    return [
      encodeRow(keyProj.map(([_, id]) => row[id]!)),
      encodeRow(valProj.map(([_, id]) => row[id]!)),
    ]
  }
}

/** Project from a single split-row, ignoring the `isValue` flag (row-form
 *  inputs only have one column array; the key half is always empty). */
function pickEncodedRow(
  proj: ReadonlyArray<[boolean, number]>,
  cols: readonly string[],
): string {
  let s = ''
  for (let i = 0; i < proj.length; i++) {
    s += cols[proj[i]![1]]!
    s += ','
  }
  return s
}

/**
 * For Kv → Kv / Kv → K transformations the input is a `[K_in, V_in]` pair.
 * Each `TransformationArgument.kind = 'KV'` carries `isValue` (which input
 * side it pulls from) and `id` (the position).
 */
function makeKvToKvFn(
  flow: TransformationFlow,
): (input: EncodedKv) => EncodedKv | null {
  const kv = requireKvFlow(flow, 'makeKvToKvFn')
  const keyProj = projectionIds(kv.key, 'makeKvToKvFn key')
  const valProj = projectionIds(kv.value, 'makeKvToKvFn value')
  const constraints = kv.constraints
  const compares = kv.compares
  const unfiltered = constraints.isEmpty() && compares.length === 0
  if (unfiltered) {
    return ([encK, encV]) => {
      const k = splitEncoded(encK)
      const v = splitEncoded(encV)
      return [pickEncodedKv(keyProj, k, v), pickEncodedKv(valProj, k, v)]
    }
  }
  return ([encK, encV]) => {
    const k = decodeRow(encK)
    const v = decodeRow(encV)
    if (!passesFilters(constraints, compares, kvReader(k, v))) return null
    const project = (proj: [boolean, number][]) =>
      proj.map(([isValue, id]) => (isValue ? v[id]! : k[id]!))
    return [encodeRow(project(keyProj)), encodeRow(project(valProj))]
  }
}

function makeKvToKFn(
  flow: TransformationFlow,
): (input: EncodedKv) => EncodedRow | null {
  const kv = requireKvFlow(flow, 'makeKvToKFn')
  const proj = projectionIds(kv.key.length > 0 ? kv.key : kv.value, 'makeKvToKFn')
  const constraints = kv.constraints
  const compares = kv.compares
  const unfiltered = constraints.isEmpty() && compares.length === 0
  if (unfiltered) {
    return ([encK, encV]) => {
      const k = splitEncoded(encK)
      const v = splitEncoded(encV)
      return pickEncodedKv(proj, k, v)
    }
  }
  return ([encK, encV]) => {
    const k = decodeRow(encK)
    const v = decodeRow(encV)
    if (!passesFilters(constraints, compares, kvReader(k, v))) return null
    return encodeRow(proj.map(([isValue, id]) => (isValue ? v[id]! : k[id]!)))
  }
}

/** KV-flavoured pick: `[isValue, id]` selects between the k and v column
 *  arrays. Concats encoded columns directly without parsing numbers. */
function pickEncodedKv(
  proj: ReadonlyArray<[boolean, number]>,
  k: readonly string[],
  v: readonly string[],
): string {
  let s = ''
  for (let i = 0; i < proj.length; i++) {
    const [isValue, id] = proj[i]!
    s += isValue ? v[id]! : k[id]!
    s += ','
  }
  return s
}

/**
 * Project a `[K, [V_left, V_right]]` join output into the flow's declared
 * (output_key, output_value) shape. K is the shared join key; V_left/V_right
 * are the values carried by each side. Returns `null` when a fused compare
 * filter rejects the row.
 */
function makeJoinOutFn(
  flow: TransformationFlow,
  _ok: number,
  _ov: number,
): (joined: [string, [string, string]]) => { key: string; value: string } | null {
  if (flow.kind !== 'JnToKV') {
    throw new Error(`makeJoinOutFn: expected JnToKV flow, got ${flow.kind}`)
  }
  const keyProj = flow.key.map((a) => {
    if (a.kind !== 'Jn') throw new Error('makeJoinOutFn key: expected Jn')
    return [a.isRight, a.isValue, a.id] as [boolean, boolean, number]
  })
  const valProj = flow.value.map((a) => {
    if (a.kind !== 'Jn') throw new Error('makeJoinOutFn value: expected Jn')
    return [a.isRight, a.isValue, a.id] as [boolean, boolean, number]
  })
  const compares = flow.compares

  // No-compare fast path: project columns as STRING substrings; never
  // round-trip through Number. The vast majority of joins follow this
  // path (only joins whose compares span both sides need numbers).
  if (compares.length === 0) {
    return ([encK, [encVL, encVR]]) => {
      const k = splitEncoded(encK)
      const vL = splitEncoded(encVL)
      const vR = splitEncoded(encVR)
      return {
        key: pickEncoded(keyProj, k, vL, vR),
        value: pickEncoded(valProj, k, vL, vR),
      }
    }
  }

  return ([encK, [encVL, encVR]]) => {
    const k = decodeRow(encK)
    const vL = decodeRow(encVL)
    const vR = decodeRow(encVR)
    // Compares fused at the join level: evaluate against (k, vL, vR) before
    // projecting. The planner only attaches a compare here when its vars
    // span both sides — purely-left compares went into the left's KvToKv
    // flow, purely-right ditto.
    const read = jnReader(k, vL, vR)
    for (const cmp of compares) {
      if (!evalCompare(cmp, read)) return null
    }
    const pick = (proj: [boolean, boolean, number][]) =>
      proj.map(([isRight, isValue, id]) => {
        if (!isValue) return k[id]!
        return isRight ? vR[id]! : vL[id]!
      })
    return { key: encodeRow(pick(keyProj)), value: encodeRow(pick(valProj)) }
  }
}

/** Split an encoded row into its column-string parts without parsing
 *  numbers. Inverse of `encodeRow`. */
function splitEncoded(encoded: string): string[] {
  if (encoded === '') return []
  return encoded.slice(0, -1).split(',')
}

/** Project Jn-flavoured `[isRight, isValue, id]` slots into a comma-
 *  terminated encoded row, reusing the input string columns directly. */
function pickEncoded(
  proj: ReadonlyArray<[boolean, boolean, number]>,
  k: readonly string[],
  vL: readonly string[],
  vR: readonly string[],
): string {
  let s = ''
  for (let i = 0; i < proj.length; i++) {
    const [isRight, isValue, id] = proj[i]!
    s += isValue ? (isRight ? vR[id]! : vL[id]!) : k[id]!
    s += ','
  }
  return s
}

/**
 * antiJoin produces `[K, [V_left, null]]`. Only `V_left` is meaningful; the
 * right side never appears in the output. The planner never attaches
 * compares directly to the antijoin — they're baked into the right-side
 * KvToKv flow before the antijoin — so this projection is unconditional.
 */
function makeAntijoinOutFn(
  flow: TransformationFlow,
  _ok: number,
  _ov: number,
): (joined: [string, [string, null]]) => { key: string; value: string } | null {
  if (flow.kind !== 'JnToKV') {
    throw new Error(`makeAntijoinOutFn: expected JnToKV, got ${flow.kind}`)
  }
  if (flow.compares.length > 0) {
    throw new Error('makeAntijoinOutFn: unexpected compares attached to antijoin')
  }
  const keyProj = flow.key.map((a) => {
    if (a.kind !== 'Jn') throw new Error('makeAntijoinOutFn key: expected Jn')
    return [a.isRight, a.isValue, a.id] as [boolean, boolean, number]
  })
  const valProj = flow.value.map((a) => {
    if (a.kind !== 'Jn') throw new Error('makeAntijoinOutFn value: expected Jn')
    return [a.isRight, a.isValue, a.id] as [boolean, boolean, number]
  })

  return ([encK, [encVL]]) => {
    const k = decodeRow(encK)
    const vL = decodeRow(encVL)
    const pick = (proj: [boolean, boolean, number][]) =>
      proj.map(([isRight, isValue, id]) => {
        if (!isValue) return k[id]!
        if (isRight) throw new Error('antijoin: right-side value referenced in output')
        return vL[id]!
      })
    return { key: encodeRow(pick(keyProj)), value: encodeRow(pick(valProj)) }
  }
}
