// Port of flowlog/src/planning/src/transformations.rs
//
// A Transformation is a single dataflow node (unary or binary) with input
// collection(s), an output collection, and a TransformationFlow describing
// how arguments thread through.

import type { AtomArgumentSignature, ComparisonExprPos } from '../catalog/index.js'
import type { Const } from '../ast/index.js'
import { type CollectionSignature, Collection } from './collections.js'
import { type TransformationFlow, flowJoinToKv, flowKvToKv, transformationFlowToString } from './flow.js'

export type Transformation =
  | UnaryTransformation
  | BinaryTransformation

export type UnaryTransformation =
  | { kind: 'RowToRow'; input: Collection; output: Collection; flow: TransformationFlow; isNoOp: boolean }
  | { kind: 'RowToK'; input: Collection; output: Collection; flow: TransformationFlow; isNoOp: boolean }
  | { kind: 'RowToKv'; input: Collection; output: Collection; flow: TransformationFlow }
  | { kind: 'KvToKv'; input: Collection; output: Collection; flow: TransformationFlow }
  | { kind: 'KvToK'; input: Collection; output: Collection; flow: TransformationFlow }
  /** Projection onto *no* columns: a unit collection, holding the empty tuple
   *  iff the input is non-empty. This is what an existence test compiles to —
   *  a body atom sharing no variable with the rest of the body and contributing
   *  no head column. It must be deduplicated, or a relation of N rows would
   *  multiply its cartesian partner N-fold. */
  | { kind: 'RowToUnit'; input: Collection; output: Collection; flow: TransformationFlow }

export type BinaryTransformation =
  | { kind: 'JnKK'; left: Collection; right: Collection; output: Collection; flow: TransformationFlow }
  | { kind: 'JnKKv'; left: Collection; right: Collection; output: Collection; flow: TransformationFlow }
  | { kind: 'JnKvK'; left: Collection; right: Collection; output: Collection; flow: TransformationFlow }
  | { kind: 'JnKvKv'; left: Collection; right: Collection; output: Collection; flow: TransformationFlow }
  | { kind: 'Cartesian'; left: Collection; right: Collection; output: Collection; flow: TransformationFlow }
  | { kind: 'NjKvK'; left: Collection; right: Collection; output: Collection; flow: TransformationFlow }
  | { kind: 'NjKK'; left: Collection; right: Collection; output: Collection; flow: TransformationFlow }
  /** Antijoin against a unit: a *negated* existence test, `!E(0)`. There is no
   *  key to join on, so both sides are re-keyed under one sentinel and the left
   *  survives exactly when the unit is absent — i.e. when the negated atom
   *  matches nothing. */
  | { kind: 'NjCartesian'; left: Collection; right: Collection; output: Collection; flow: TransformationFlow }

const UNARY_KINDS = new Set<Transformation['kind']>([
  'RowToRow',
  'RowToK',
  'RowToKv',
  'KvToKv',
  'KvToK',
  'RowToUnit',
])

export function isUnary(t: Transformation): t is UnaryTransformation {
  return UNARY_KINDS.has(t.kind)
}

export function unaryInput(t: Transformation): Collection {
  if (
    t.kind === 'RowToRow' ||
    t.kind === 'RowToK' ||
    t.kind === 'RowToKv' ||
    t.kind === 'RowToUnit'
  ) {
    return t.input
  }
  throw new Error(`unaryInput: not a Row-input transformation (${t.kind})`)
}

export function binaryInputs(t: Transformation): [Collection, Collection] {
  if (
    t.kind === 'JnKK' ||
    t.kind === 'JnKKv' ||
    t.kind === 'JnKvK' ||
    t.kind === 'JnKvKv' ||
    t.kind === 'Cartesian' ||
    t.kind === 'NjKvK' ||
    t.kind === 'NjKK' ||
    t.kind === 'NjCartesian'
  ) {
    return [t.left, t.right]
  }
  throw new Error(`binaryInputs: not a binary transformation (${t.kind})`)
}

export function transformationOutput(t: Transformation): Collection {
  return t.output
}

export function transformationFlow(t: Transformation): TransformationFlow {
  return t.flow
}

// -------------------------------
// builders
// -------------------------------

export function buildKvToKv(
  input: Collection,
  outputKeySignatures: readonly AtomArgumentSignature[],
  outputValueSignatures: readonly AtomArgumentSignature[],
  constEqConstraints: ReadonlyArray<readonly [AtomArgumentSignature, Const]>,
  varEqConstraints: ReadonlyArray<readonly [AtomArgumentSignature, AtomArgumentSignature]>,
  compareExprs: readonly ComparisonExprPos[],
): Transformation {
  const flow = flowKvToKv(
    input.keyArgumentSignatures,
    input.valueArgumentSignatures,
    outputKeySignatures,
    outputValueSignatures,
    constEqConstraints,
    varEqConstraints,
    compareExprs,
  )

  const isRowIn = input.keyArgumentSignatures.length === 0
  const isRowOut = outputKeySignatures.length === 0
  const isKeyOnlyOut = outputValueSignatures.length === 0

  // Identity check used to flag no-op transformations.
  let inputSigsMatch = false
  if (isRowIn && (isRowOut || isKeyOnlyOut)) {
    const inputAll = [...input.keyArgumentSignatures, ...input.valueArgumentSignatures]
    const outputAll = [...outputKeySignatures, ...outputValueSignatures]
    if (inputAll.length === outputAll.length) {
      inputSigsMatch = inputAll.every((sig, i) => sig.key === outputAll[i]!.key)
    }
  }
  const isNoOp =
    isRowIn &&
    (isRowOut || isKeyOnlyOut) &&
    constEqConstraints.length === 0 &&
    varEqConstraints.length === 0 &&
    compareExprs.length === 0 &&
    inputSigsMatch

  const inputName = input.signature.name
  let outputName: string
  if (isRowOut && !isKeyOnlyOut) outputName = `Row(${inputName})${transformationFlowToString(flow)}`
  else if (!isRowOut && isKeyOnlyOut) outputName = `K(${inputName})${transformationFlowToString(flow)}`
  else if (!isRowOut && !isKeyOnlyOut) outputName = `Kv(${inputName})${transformationFlowToString(flow)}`
  // Neither key nor value columns survive. That is not a malformed plan — it is
  // an existence test: the atom shares no variable with the rest of the body and
  // contributes nothing to the head, so all that matters is whether it holds at
  // all. The output is a unit collection, and the cartesian join downstream
  // gates its partner on the unit being present.
  else outputName = `Unit(${inputName})${transformationFlowToString(flow)}`

  const outputSig: CollectionSignature = { kind: 'UnaryTransformationOutput', name: outputName }
  const output = new Collection(outputSig, [...outputKeySignatures], [...outputValueSignatures])

  if (isRowOut && isKeyOnlyOut) return { kind: 'RowToUnit', input, output, flow }
  if (isRowIn && isRowOut) return { kind: 'RowToRow', input, output, flow, isNoOp }
  if (isRowIn && !isRowOut && isKeyOnlyOut) return { kind: 'RowToK', input, output, flow, isNoOp }
  if (isRowIn && !isRowOut && !isKeyOnlyOut) return { kind: 'RowToKv', input, output, flow }
  if (!isRowIn && !isRowOut && !isKeyOnlyOut) return { kind: 'KvToKv', input, output, flow }
  if (!isRowIn && !isRowOut && isKeyOnlyOut) return { kind: 'KvToK', input, output, flow }
  throw new Error('buildKvToKv: unexpected kv-to-row transformation')
}

export function buildJoin(
  left: Collection,
  right: Collection,
  outputKeySignatures: readonly AtomArgumentSignature[],
  outputValueSignatures: readonly AtomArgumentSignature[],
  compareExprs: readonly ComparisonExprPos[],
): Transformation {
  const [leftKeys, leftValues] = [left.keyArgumentSignatures, left.valueArgumentSignatures]
  const [rightKeys, rightValues] = [right.keyArgumentSignatures, right.valueArgumentSignatures]

  const flow = flowJoinToKv(
    leftKeys,
    leftValues,
    rightKeys,
    rightValues,
    outputKeySignatures,
    outputValueSignatures,
    compareExprs,
  )

  const isKeyOnlyLeft = leftValues.length === 0
  const isKeyOnlyRight = rightValues.length === 0
  const isCartesian = leftKeys.length === 0
  const leftName = left.signature.name
  const rightName = right.signature.name
  const flowStr = transformationFlowToString(flow)

  let name: string
  if (isCartesian) name = `Cartesian(${leftName}, ${rightName})${flowStr}`
  else if (isKeyOnlyLeft && isKeyOnlyRight) name = `JnKK(${leftName}, ${rightName})${flowStr}`
  else if (!isKeyOnlyLeft && isKeyOnlyRight) name = `JnKvK(${leftName}, ${rightName})${flowStr}`
  else if (!isKeyOnlyLeft && !isKeyOnlyRight) name = `JnKvKv(${leftName}, ${rightName})${flowStr}`
  else name = `JnKKv(${leftName}, ${rightName})${flowStr}`

  const outputSig: CollectionSignature = { kind: 'JnOutput', name }
  const output = new Collection(outputSig, [...outputKeySignatures], [...outputValueSignatures])

  if (isCartesian) return { kind: 'Cartesian', left, right, output, flow }
  if (isKeyOnlyLeft && isKeyOnlyRight) return { kind: 'JnKK', left, right, output, flow }
  if (!isKeyOnlyLeft && isKeyOnlyRight) return { kind: 'JnKvK', left, right, output, flow }
  if (!isKeyOnlyLeft && !isKeyOnlyRight) return { kind: 'JnKvKv', left, right, output, flow }
  return { kind: 'JnKKv', left, right, output, flow }
}

export function buildAntijoin(
  left: Collection,
  right: Collection,
  outputKeySignatures: readonly AtomArgumentSignature[],
  outputValueSignatures: readonly AtomArgumentSignature[],
): Transformation {
  if (right.valueArgumentSignatures.length !== 0) {
    throw new Error('buildAntijoin: right_value_signatures must be empty')
  }
  const flow = flowJoinToKv(
    left.keyArgumentSignatures,
    left.valueArgumentSignatures,
    right.keyArgumentSignatures,
    right.valueArgumentSignatures,
    outputKeySignatures,
    outputValueSignatures,
    [],
  )

  const isKeyOnlyLeft = left.valueArgumentSignatures.length === 0
  // No key on either side: the negated atom shares no variable with the rest of
  // the body, so this is a negated existence test rather than a keyed antijoin.
  const isCartesian = left.keyArgumentSignatures.length === 0
  const flowStr = transformationFlowToString(flow)
  const name = isCartesian
    ? `NjCartesian(${left.signature.name}, ${right.signature.name})${flowStr}`
    : isKeyOnlyLeft
      ? `NjKK(${left.signature.name}, ${right.signature.name})${flowStr}`
      : `NjKvK(${left.signature.name}, ${right.signature.name})${flowStr}`

  const outputSig: CollectionSignature = { kind: 'NegJnOutput', name }
  const output = new Collection(outputSig, [...outputKeySignatures], [...outputValueSignatures])

  if (isCartesian) return { kind: 'NjCartesian', left, right, output, flow }
  return isKeyOnlyLeft
    ? { kind: 'NjKK', left, right, output, flow }
    : { kind: 'NjKvK', left, right, output, flow }
}

export function transformationToString(t: Transformation): string {
  switch (t.kind) {
    case 'RowToRow':
      return `${t.isNoOp ? '∅' : '→'} ${t.output.pprint()}`
    case 'RowToK':
      return `${t.isNoOp ? '∅' : '⟶'} ${t.output.pprint()}`
    case 'RowToKv':
    case 'KvToKv':
    case 'KvToK':
      return `⟶ ${t.output.pprint()}`
    case 'RowToUnit':
      return `∃ ${t.output.pprint()}`
    case 'JnKK':
    case 'JnKKv':
    case 'JnKvK':
    case 'JnKvKv':
      return `⋈ ${t.output.pprint()}`
    case 'Cartesian':
      return `⨯ ${t.output.pprint()}`
    case 'NjKvK':
    case 'NjKK':
    case 'NjCartesian':
      return `¬ ${t.output.pprint()}`
  }
}
