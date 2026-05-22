// Port of flowlog/src/planning/src/flow.rs
//
// TransformationFlow captures the dataflow shape of a single transformation:
//   - KVToKV: filter / project a keyed collection
//   - JnToKV: produce a keyed collection from a join of two
//   - HeadArith: post-map applying head arithmetic projections

import {
  type AtomArgumentSignature,
  type ComparisonExprPos,
  SignatureMap,
} from '../catalog/index.js'
import type { Const } from '@flow-ts/parsing'
import {
  type TransformationArgument,
  jnFlip,
  transformationArgumentToString,
} from './arguments.js'
import { ArithmeticArgument } from './arithmetic.js'
import { ComparisonExprArgument } from './compare.js'
import { BaseConstraints } from './constraints.js'

export type HeadProjection =
  | { kind: 'Copy'; index: number }
  | { kind: 'Compute'; arithmetic: ArithmeticArgument }

export type TransformationFlow =
  | {
      kind: 'KVToKV'
      key: TransformationArgument[]
      value: TransformationArgument[]
      constraints: BaseConstraints
      compares: ComparisonExprArgument[]
    }
  | {
      kind: 'JnToKV'
      key: TransformationArgument[]
      value: TransformationArgument[]
      compares: ComparisonExprArgument[]
    }
  | { kind: 'HeadArith'; projections: HeadProjection[] }

export function flowConstraints(flow: TransformationFlow): BaseConstraints {
  if (flow.kind === 'KVToKV') return flow.constraints
  throw new Error(`flowConstraints called on ${flow.kind}`)
}

export function flowCompares(flow: TransformationFlow): readonly ComparisonExprArgument[] {
  switch (flow.kind) {
    case 'KVToKV':
      return flow.compares
    case 'JnToKV':
      return flow.compares
    case 'HeadArith':
      return []
  }
}

export function flowIsConstrained(flow: TransformationFlow): boolean {
  switch (flow.kind) {
    case 'KVToKV':
      return !(flow.constraints.isEmpty() && flow.compares.length === 0)
    case 'JnToKV':
      return flow.compares.length > 0
    case 'HeadArith':
      return false
  }
}

export function flowIsKeyEmpty(flow: TransformationFlow): boolean {
  switch (flow.kind) {
    case 'KVToKV':
    case 'JnToKV':
      return flow.key.length === 0
    case 'HeadArith':
      return true
  }
}

/** Flip the underlying join arguments — only valid for JnToKV flows. */
export function flowJnFlip(flow: TransformationFlow): TransformationFlow {
  if (flow.kind !== 'JnToKV') {
    throw new Error('flowJnFlip called on non-JnToKV')
  }
  return {
    kind: 'JnToKV',
    key: flow.key.map(jnFlip),
    value: flow.value.map(jnFlip),
    compares: flow.compares.map((c) => c.jnFlip()),
  }
}

/** Map argument signatures → KV transformation arguments. */
export function kvArgumentFlowMap(
  keySignatures: readonly AtomArgumentSignature[],
  valueSignatures: readonly AtomArgumentSignature[],
): SignatureMap<TransformationArgument> {
  const out = new SignatureMap<TransformationArgument>()
  for (let id = 0; id < keySignatures.length; id++) {
    out.set(keySignatures[id]!, { kind: 'KV', isValue: false, id })
  }
  for (let id = 0; id < valueSignatures.length; id++) {
    out.set(valueSignatures[id]!, { kind: 'KV', isValue: true, id })
  }
  return out
}

function flowOverSignatures(
  inputSignatureMap: SignatureMap<TransformationArgument>,
  outputSignatures: readonly AtomArgumentSignature[],
  context: string,
): TransformationArgument[] {
  return outputSignatures.map((sig) => {
    const v = inputSignatureMap.get(sig)
    if (!v) {
      throw new Error(`${context}: signature ${sig.toString()} absent from input map`)
    }
    return v
  })
}

export function flowKvToKv(
  inputKeySignatures: readonly AtomArgumentSignature[],
  inputValueSignatures: readonly AtomArgumentSignature[],
  outputKeySignatures: readonly AtomArgumentSignature[],
  outputValueSignatures: readonly AtomArgumentSignature[],
  constEqConstraints: ReadonlyArray<readonly [AtomArgumentSignature, Const]>,
  varEqConstraints: ReadonlyArray<readonly [AtomArgumentSignature, AtomArgumentSignature]>,
  compareExprs: readonly ComparisonExprPos[],
): TransformationFlow {
  const inputMap = kvArgumentFlowMap(inputKeySignatures, inputValueSignatures)
  const flowKey = flowOverSignatures(inputMap, outputKeySignatures, 'kv_to_kv key')
  const flowValue = flowOverSignatures(inputMap, outputValueSignatures, 'kv_to_kv value')

  const constArgs = flowOverSignatures(
    inputMap,
    constEqConstraints.map(([s]) => s),
    'kv_to_kv const',
  )
  const flowConsts: Array<readonly [TransformationArgument, Const]> = constArgs.map(
    (a, i) => [a, constEqConstraints[i]![1]] as const,
  )

  const leftSigs = varEqConstraints.map(([l]) => l)
  const aliasSigs = varEqConstraints.map(([, r]) => r)
  const flowVar = flowOverSignatures(inputMap, leftSigs, 'kv_to_kv var left')
  const flowAlias = flowOverSignatures(inputMap, aliasSigs, 'kv_to_kv var right')
  const flowVarEq: Array<readonly [TransformationArgument, TransformationArgument]> =
    flowVar.map((v, i) => [v, flowAlias[i]!] as const)

  const flowCmps: ComparisonExprArgument[] = compareExprs.map((cmp) => {
    const leftSignatures = cmp.left.signatures()
    const rightSignatures = cmp.right.signatures()
    return ComparisonExprArgument.fromComparisonExpr(
      cmp,
      flowOverSignatures(inputMap, leftSignatures, 'kv_to_kv compare left'),
      flowOverSignatures(inputMap, rightSignatures, 'kv_to_kv compare right'),
    )
  })

  return {
    kind: 'KVToKV',
    key: flowKey,
    value: flowValue,
    constraints: new BaseConstraints(flowConsts, flowVarEq),
    compares: flowCmps,
  }
}

export function flowJoinToKv(
  inputLeftKeySignatures: readonly AtomArgumentSignature[],
  inputLeftValueSignatures: readonly AtomArgumentSignature[],
  _inputRightKeySignatures: readonly AtomArgumentSignature[],
  inputRightValueSignatures: readonly AtomArgumentSignature[],
  outputKeySignatures: readonly AtomArgumentSignature[],
  outputValueSignatures: readonly AtomArgumentSignature[],
  compareExprs: readonly ComparisonExprPos[],
): TransformationFlow {
  // Re-tag each side's KV arguments as Jn arguments (isRight = false / true).
  const leftKvMap = kvArgumentFlowMap(inputLeftKeySignatures, inputLeftValueSignatures)
  const rightKvMap = kvArgumentFlowMap([], inputRightValueSignatures)
  const inputMap = new SignatureMap<TransformationArgument>()
  for (const [sig, arg] of leftKvMap.entries()) {
    if (arg.kind !== 'KV') {
      throw new Error('flowJoinToKv expects KV in left input')
    }
    inputMap.set(sig, { kind: 'Jn', isRight: false, isValue: arg.isValue, id: arg.id })
  }
  for (const [sig, arg] of rightKvMap.entries()) {
    if (arg.kind !== 'KV') {
      throw new Error('flowJoinToKv expects KV in right input')
    }
    inputMap.set(sig, { kind: 'Jn', isRight: true, isValue: arg.isValue, id: arg.id })
  }

  const flowKey = flowOverSignatures(inputMap, outputKeySignatures, 'join_to_kv key')
  const flowValue = flowOverSignatures(inputMap, outputValueSignatures, 'join_to_kv value')

  const flowCmps: ComparisonExprArgument[] = compareExprs.map((cmp) => {
    const leftSignatures = cmp.left.signatures()
    const rightSignatures = cmp.right.signatures()
    return ComparisonExprArgument.fromComparisonExpr(
      cmp,
      flowOverSignatures(inputMap, leftSignatures, 'join_to_kv compare left'),
      flowOverSignatures(inputMap, rightSignatures, 'join_to_kv compare right'),
    )
  })

  return {
    kind: 'JnToKV',
    key: flowKey,
    value: flowValue,
    compares: flowCmps,
  }
}

function formatArgList(args: readonly TransformationArgument[]): string {
  return args.map(transformationArgumentToString).join(', ')
}

export function transformationFlowToString(flow: TransformationFlow): string {
  switch (flow.kind) {
    case 'KVToKV': {
      const hasConstraints = !flow.constraints.isEmpty()
      const hasCompares = flow.compares.length > 0
      let filters = ''
      if (hasConstraints && !hasCompares) filters = ` if ${flow.constraints.toString()}`
      else if (!hasConstraints && hasCompares)
        filters = ` if ${flow.compares.map((c) => c.toString()).join(', ')}`
      else if (hasConstraints && hasCompares)
        filters = ` if ${flow.constraints.toString()} and ${flow.compares.map((c) => c.toString()).join(', ')}`
      return flow.key.length === 0
        ? `|(${formatArgList(flow.value)})${filters}|`
        : `|(${formatArgList(flow.key)}: ${formatArgList(flow.value)})${filters}|`
    }
    case 'JnToKV': {
      const filters =
        flow.compares.length > 0
          ? ` if ${flow.compares.map((c) => c.toString()).join(', ')}`
          : ''
      return flow.key.length === 0
        ? `|(${formatArgList(flow.value)})${filters}|`
        : `|(${formatArgList(flow.key)}: ${formatArgList(flow.value)})${filters}|`
    }
    case 'HeadArith': {
      const parts = flow.projections.map((p) =>
        p.kind === 'Copy' ? `v${p.index}` : p.arithmetic.toString(),
      )
      return `|head_arith(${parts.join(', ')})|`
    }
  }
}
