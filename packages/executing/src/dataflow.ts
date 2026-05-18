// Port of flowlog/src/executing/src/dataflow.rs (incremental).
//
// Builds a d2ts dataflow graph from a ProgramQueryPlan, loads EDB facts via
// the reading crate, runs the graph, and surfaces IDB results via a
// caller-provided sink callback.
//
// Encoding strategy:
//   - Row streams:    `IStreamBuilder<string>`             (encoded row)
//   - Keyed streams:  `IStreamBuilder<[string, string]>`   (encoded key, encoded value)
//   - K-only streams: `IStreamBuilder<string>`             (encoded row == key)
//
// String encoding sidesteps d2ts's two limitations on bigint-bearing
// row arrays (JS Map identity + JSON.stringify in delta tracking).
//
// **Status**: handles single-IDB strata with the most common transformation
// kinds (RowTo*/KvTo*/Jn*/Nj*/Cartesian). Aggregation, head arithmetic,
// comparison filtering, var-equality constraints, and multi-IDB recursive
// strata are stubbed and will throw if encountered.

import {
  D2,
  MessageType,
  type IStreamBuilder,
  type KeyValue,
  type RootStreamBuilder,
  antiJoin,
  concat,
  distinct,
  filter,
  innerJoin,
  map,
  output,
} from '@electric-sql/d2ts'
import { iterateMulti } from './iterate-multi.js'
import { aggregationCatalogFromProgram } from '@flow-ts/catalog'
import { parseProgram } from '@flow-ts/parsing'
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
import {
  type Row,
  decodeRow,
  encodeRow,
  readRowsForRelDecl,
} from '@flow-ts/reading'
import { Strata } from '@flow-ts/strata'
import * as fs from 'node:fs'
import { Args } from './arg.js'

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

export function executeProgram(args: Args, sink: IdbSink): void {
  const source = fs.readFileSync(args.program, 'utf8')
  const program = parseProgram(source, { grammarSource: args.program })
  const strata = Strata.fromParser(program)
  const plan = ProgramQueryPlanCls.fromStrata(strata, args.noSharing, args.optLevel)
  // Aggregation hook-up is TODO; we look the catalog up but don't use it yet.
  void aggregationCatalogFromProgram(program)

  const graph = new D2({ initialFrontier: 0 })

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

  buildProgramDataflow(graph, plan, maps, sink, new Set(program.idbs.map((d) => d.name)))

  graph.finalize()

  for (const edb of program.edbs) {
    if (!edb.path) continue
    const input = edbInputs.get(edb.name)!
    const rows = readRowsForRelDecl(edb, args.facts, args.delimiter)
    for (const row of rows) {
      input.sendData(0, [[encodeRow(row), 1]])
    }
    input.sendFrontier(1)
  }
  graph.run()
}

function buildProgramDataflow(
  graph: D2,
  plan: ProgramQueryPlan,
  maps: DataflowMaps,
  sink: IdbSink,
  idbSet: ReadonlySet<string>,
): void {
  for (const groupPlan of plan.programPlan) {
    if (groupPlan.isRecursive) {
      buildRecursiveStratum(graph, groupPlan, maps)
    } else {
      buildNonRecursiveStratum(groupPlan, maps)
    }
  }
  // Sink each IDB head's final stream after all strata are processed. This
  // way, a head produced by both a non-recursive and a recursive stratum
  // (the reach.dl pattern) only sinks the converged recursive result.
  for (const idbName of idbSet) {
    const stream = maps.rowMap.get(idbName)
    if (!stream) continue
    stream.pipe(
      output((msg) => {
        if (msg.type !== MessageType.DATA) return
        for (const [encoded, mult] of msg.data.collection.getInner()) {
          sink(idbName, decodeRow(encoded), mult)
        }
      }),
    )
  }
}

function buildNonRecursiveStratum(
  groupPlan: GroupStrataQueryPlan,
  maps: DataflowMaps,
): void {
  for (const t of groupPlan.strataPlanFlat()) {
    applyTransformation(t, maps)
  }
  registerHeads(groupPlan, maps)
}

/**
 * After a stratum's transformations are wired, populate `maps.rowMap[head]`
 * for every IDB head it produces — the union of all rules' last outputs,
 * deduped. Subsequent strata can then reference the head as a base atom.
 */
function registerHeads(groupPlan: GroupStrataQueryPlan, maps: DataflowMaps): void {
  for (const [headName, lasts] of groupPlan.lastSignaturesMap) {
    if (maps.rowMap.has(headName)) continue // already registered (recursive case)
    let unioned: IStreamBuilder<EncodedRow> | null = null
    for (const last of lasts) {
      const s = maps.rowMap.get(last)
      if (!s) continue
      unioned = unioned === null ? s : unioned.pipe(concat(s))
    }
    if (unioned !== null) {
      maps.rowMap.set(headName, dedupeEncodedRows(unioned))
    }
  }
}

/**
 * Recursive stratum executor — mirrors Rust DD's `scope.iterative` pattern.
 *
 *   1. Externals (EDBs, prior-stratum non-head IDBs, and any prior data for
 *      the head itself) are persistently entered into the scope via
 *      `persistentIngress`. This is the analog of DD's `.enter(scope)`; it
 *      differs from d2ts's stock `iterate(f)` which negates the seed at
 *      inner step 1 (the canonical example doesn't notice because its body
 *      only references the iter variable).
 *
 *   2. One feedback variable per IDB head in the stratum. Currently we
 *      only support a single head; multi-head mutual recursion is the same
 *      pattern, just with N variables in the `variableNames` list.
 *
 *   3. Inside the body, `nestMaps.rowMap[headName]` resolves to the
 *      variable handle. Recursive references to the IDB pick it up; EDB
 *      lookups resolve to the persistently-entered streams.
 *
 *   4. The body concatenates per-rule outputs plus any prior-stratum seed
 *      for the head (the `recursive_collector` analog), dedupes, and
 *      returns. `iterateMulti` wires that as the variable's new value via
 *      a `FeedbackOperator`. After convergence the egressed result is
 *      registered back into `maps.rowMap`.
 */
function buildRecursiveStratum(
  graph: D2,
  groupPlan: GroupStrataQueryPlan,
  maps: DataflowMaps,
): void {
  const heads = [...groupPlan.headSignaturesSet()]
  if (heads.length !== 1) {
    throw new Error(
      `recursive strata with ${heads.length} IDB heads not yet supported (got ${heads.join(', ')})`,
    )
  }
  const headName = heads[0]!

  // Externals = EDBs / prior-stratum IDBs the transformations read from.
  const baseRels = baseInputRelations(groupPlan)
  const externals: Record<string, IStreamBuilder<EncodedRow>> = {}
  for (const relName of baseRels) {
    if (relName === headName) continue
    const outer = maps.rowMap.get(relName)
    if (outer) externals[relName] = outer
  }
  // Prior-stratum data for the head itself (e.g. reach.dl's group-0 IDB).
  // Entered separately so the body can concat it with per-rule outputs —
  // the analog of the Rust `recursive_collector` adding `init_rel`.
  const priorKey = `__prior__${headName}`
  const prior = maps.rowMap.get(headName)
  if (prior) externals[priorKey] = prior

  const results = iterateMulti<
    string,
    typeof headName,
    Record<string, EncodedRow>,
    Record<typeof headName, EncodedRow>
  >(graph, externals, [headName] as const, (entered, variables) => {
    const nestMaps: DataflowMaps = {
      rowMap: new Map(),
      kvMap: new Map(),
      kMap: new Map(),
    }
    const headVar = variables[headName]!
    for (const relName of baseRels) {
      if (relName === headName) {
        nestMaps.rowMap.set(relName, headVar)
      } else {
        const s = entered[relName]
        if (s) nestMaps.rowMap.set(relName, s)
      }
    }

    for (const t of groupPlan.strataPlanFlat()) {
      applyTransformation(t, nestMaps)
    }

    const lasts = groupPlan.lastSignaturesMap.get(headName) ?? []
    let unioned: IStreamBuilder<EncodedRow> | null = null
    for (const last of lasts) {
      const s = nestMaps.rowMap.get(last)
      if (!s) continue
      unioned = unioned === null ? s : unioned.pipe(concat(s))
    }
    const priorEntered = entered[priorKey]
    if (priorEntered) {
      unioned = unioned === null ? priorEntered : unioned.pipe(concat(priorEntered))
    }
    const next =
      unioned === null ? headVar.pipe(filter(() => false)) : dedupeEncodedRows(unioned)
    return { [headName]: next } as Record<typeof headName, IStreamBuilder<EncodedRow>>
  })

  const finalHead = results[headName]!
  maps.rowMap.set(headName, finalHead)
}

/**
 * Find the base (Atom-kind) relations referenced by transformations in a
 * stratum. These are the relations whose streams we need either in the seed
 * (EDBs / prior IDBs) or derived from the iteration variable (the recursive
 * IDB heads). Transformations that read intermediate outputs reference the
 * other transformations directly and don't need separate seeding.
 */
function baseInputRelations(groupPlan: GroupStrataQueryPlan): Set<string> {
  const out = new Set<string>()
  for (const t of groupPlan.strataPlanFlat()) {
    if (isUnary(t)) {
      const sig = unaryInput(t).signature
      if (sig.kind === 'Atom') out.add(sig.name)
    } else {
      const [l, r] = binaryInputs(t as BinaryTransformation)
      if (l.signature.kind === 'Atom') out.add(l.signature.name)
      if (r.signature.kind === 'Atom') out.add(r.signature.name)
    }
  }
  return out
}

/** Union all `lastSignaturesMap` entries for each IDB head and route to sink. */
function collectHeads(
  groupPlan: GroupStrataQueryPlan,
  maps: DataflowMaps,
  idbSet: ReadonlySet<string>,
  sink: IdbSink,
): void {
  for (const [headName, lasts] of groupPlan.lastSignaturesMap) {
    if (!idbSet.has(headName)) continue
    let stream: IStreamBuilder<EncodedRow> | null = null
    // If the head is recursive, the iterate already populated maps.rowMap.
    const existing = maps.rowMap.get(headName)
    if (existing) {
      stream = existing
    } else {
      for (const last of lasts) {
        const s = maps.rowMap.get(last)
        if (!s) continue
        stream = stream === null ? s : stream.pipe(concat(s))
      }
    }
    if (!stream) continue
    dedupeEncodedRows(stream).pipe(
      output((msg) => {
        if (msg.type !== MessageType.DATA) return
        for (const [encoded, mult] of msg.data.collection.getInner()) {
          sink(headName, decodeRow(encoded), mult)
        }
      }),
    )
  }
}

/** Dedupe an encoded-row stream (matches reading's dedupeRowStream). */
function dedupeEncodedRows(
  stream: IStreamBuilder<EncodedRow>,
): IStreamBuilder<EncodedRow> {
  return stream.pipe(
    map((r) => [r, r] as [string, string]),
    distinct<string, string, [string, string]>(),
    map(([, v]) => v),
  )
}

// -----------------------------------------------------------------------
// Per-transformation translation
// -----------------------------------------------------------------------

function applyTransformation(t: Transformation, maps: DataflowMaps): void {
  const outName = transformationOutput(t).signature.name
  if (isUnary(t)) {
    applyUnary(t, maps, outName)
    return
  }
  applyBinary(t, maps, outName)
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
  fn: (j: JoinOut) => { key: string; value: string },
  ok: number,
  ov: number,
): void {
  if (ok === 0) {
    // row form: encoded value is the whole row
    const out = joined.pipe(map((j) => fn(j).value))
    maps.rowMap.set(outName, out)
  } else if (ov === 0) {
    // k-only form: encoded key is the whole row
    const out = joined.pipe(map((j) => fn(j).key))
    maps.kMap.set(outName, out)
  } else {
    // kv form
    const out = joined.pipe(map((j): EncodedKv => {
      const r = fn(j)
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
// Flow → projection-function builders
// -----------------------------------------------------------------------

function projectionIds(
  args: readonly { kind: 'KV' | 'Jn' }[],
  ctx: string,
): number[] {
  return args.map((a) => {
    if (a.kind !== 'KV') throw new Error(`${ctx}: expected KV arg`)
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return (a as { kind: 'KV'; id: number }).id
  })
}

function requireSimpleFlow(flow: TransformationFlow, ctx: string): void {
  if (flow.kind !== 'KVToKV') {
    throw new Error(`${ctx}: expected KVToKV flow, got ${flow.kind}`)
  }
  if (!flow.constraints.isEmpty() || flow.compares.length > 0) {
    throw new Error(`${ctx}: constraints/compares not yet implemented`)
  }
}

function makeRowToRowFn(flow: TransformationFlow): (encoded: string) => string | null {
  requireSimpleFlow(flow, 'makeRowToRowFn')
  // For RowToRow / RowToK, exactly one of `key`/`value` is populated.
  const kv = flow as Extract<TransformationFlow, { kind: 'KVToKV' }>
  const idsSource = kv.key.length === 0 ? kv.value : kv.key
  const ids = projectionIds(idsSource, 'makeRowToRowFn')
  return (encoded) => {
    const row = decodeRow(encoded)
    const out = ids.map((i) => row[i]!)
    return encodeRow(out)
  }
}

function makeRowToKvFn(
  flow: TransformationFlow,
): (encoded: string) => EncodedKv | null {
  requireSimpleFlow(flow, 'makeRowToKvFn')
  const kv = flow as Extract<TransformationFlow, { kind: 'KVToKV' }>
  const keyIds = projectionIds(kv.key, 'makeRowToKvFn key')
  const valIds = projectionIds(kv.value, 'makeRowToKvFn value')
  return (encoded) => {
    const row = decodeRow(encoded)
    return [encodeRow(keyIds.map((i) => row[i]!)), encodeRow(valIds.map((i) => row[i]!))]
  }
}

/**
 * For Kv → Kv / Kv → K transformations the input is a `[K_in, V_in]` pair.
 * Each output `TransformationArgument.kind = 'KV'` carries `isValue` (which
 * input side it pulls from) and `id` (the position).
 */
function makeKvToKvFn(
  flow: TransformationFlow,
): (input: EncodedKv) => EncodedKv | null {
  requireSimpleFlow(flow, 'makeKvToKvFn')
  const kv = flow as Extract<TransformationFlow, { kind: 'KVToKV' }>
  const keyProj = kv.key.map((a) => {
    if (a.kind !== 'KV') throw new Error('makeKvToKvFn: expected KV')
    return [a.isValue, a.id] as [boolean, number]
  })
  const valProj = kv.value.map((a) => {
    if (a.kind !== 'KV') throw new Error('makeKvToKvFn: expected KV')
    return [a.isValue, a.id] as [boolean, number]
  })
  return ([encK, encV]) => {
    const k = decodeRow(encK)
    const v = decodeRow(encV)
    const project = (proj: [boolean, number][]) =>
      proj.map(([isValue, id]) => (isValue ? v[id]! : k[id]!))
    return [encodeRow(project(keyProj)), encodeRow(project(valProj))]
  }
}

function makeKvToKFn(
  flow: TransformationFlow,
): (input: EncodedKv) => EncodedRow | null {
  requireSimpleFlow(flow, 'makeKvToKFn')
  const kv = flow as Extract<TransformationFlow, { kind: 'KVToKV' }>
  // For Kv→K the output is a single row carried in either the key (typical)
  // or value (degenerate); the planner uses `key` when ok > 0.
  const proj = (kv.key.length > 0 ? kv.key : kv.value).map((a) => {
    if (a.kind !== 'KV') throw new Error('makeKvToKFn: expected KV')
    return [a.isValue, a.id] as [boolean, number]
  })
  return ([encK, encV]) => {
    const k = decodeRow(encK)
    const v = decodeRow(encV)
    return encodeRow(proj.map(([isValue, id]) => (isValue ? v[id]! : k[id]!)))
  }
}

/**
 * Project a `[K, [V_left, V_right]]` join output into the flow's declared
 * (output_key, output_value) shape. K is the shared join key; V_left/V_right
 * are the values carried by each side.
 */
function makeJoinOutFn(
  flow: TransformationFlow,
  _ok: number,
  _ov: number,
): (joined: [string, [string, string]]) => { key: string; value: string } {
  if (flow.kind !== 'JnToKV') {
    throw new Error(`makeJoinOutFn: expected JnToKV flow, got ${flow.kind}`)
  }
  if (flow.compares.length > 0) {
    throw new Error('makeJoinOutFn: compare filters not yet implemented')
  }
  const keyProj = flow.key.map((a) => {
    if (a.kind !== 'Jn') throw new Error('makeJoinOutFn key: expected Jn')
    return [a.isRight, a.isValue, a.id] as [boolean, boolean, number]
  })
  const valProj = flow.value.map((a) => {
    if (a.kind !== 'Jn') throw new Error('makeJoinOutFn value: expected Jn')
    return [a.isRight, a.isValue, a.id] as [boolean, boolean, number]
  })

  return ([encK, [encVL, encVR]]) => {
    const k = decodeRow(encK)
    const vL = decodeRow(encVL)
    const vR = decodeRow(encVR)
    const pick = (proj: [boolean, boolean, number][]) =>
      proj.map(([_isRight, isValue, id]) => {
        // Both sides of an inner join share the same K, so `isRight` doesn't
        // affect key lookups — the shared K is on both sides.
        if (!isValue) return k[id]!
        // value side: which side's value?
        return _isRight ? vR[id]! : vL[id]!
      })
    return { key: encodeRow(pick(keyProj)), value: encodeRow(pick(valProj)) }
  }
}

/**
 * antiJoin produces `[K, [V_left, null]]`. Only `V_left` is meaningful; the
 * right side never appears in the output.
 */
function makeAntijoinOutFn(
  flow: TransformationFlow,
  _ok: number,
  _ov: number,
): (joined: [string, [string, null]]) => { key: string; value: string } {
  if (flow.kind !== 'JnToKV') {
    throw new Error(`makeAntijoinOutFn: expected JnToKV, got ${flow.kind}`)
  }
  if (flow.compares.length > 0) {
    throw new Error('makeAntijoinOutFn: compare filters not yet implemented')
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
