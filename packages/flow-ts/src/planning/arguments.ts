// Port of flowlog/src/planning/src/arguments.rs
//
// A TransformationArgument references either a position inside a single
// keyed collection (KV) or a position inside one side of a join (Jn).

export type TransformationArgument =
  | { kind: 'KV'; isValue: boolean; id: number }
  | { kind: 'Jn'; isRight: boolean; isValue: boolean; id: number }

export function kvIndices(a: TransformationArgument): [boolean, number] {
  if (a.kind !== 'KV') throw new Error(`kvIndices expects KV: ${JSON.stringify(a)}`)
  return [a.isValue, a.id]
}

export function jnIndices(a: TransformationArgument): [boolean, boolean, number] {
  if (a.kind !== 'Jn') throw new Error(`jnIndices expects Jn: ${JSON.stringify(a)}`)
  return [a.isRight, a.isValue, a.id]
}

/** Flip a join argument from left ↔ right. */
export function jnFlip(a: TransformationArgument): TransformationArgument {
  if (a.kind !== 'Jn') throw new Error(`jnFlip expects Jn: ${JSON.stringify(a)}`)
  return { kind: 'Jn', isRight: !a.isRight, isValue: a.isValue, id: a.id }
}

export function transformationArgumentToString(a: TransformationArgument): string {
  if (a.kind === 'KV') {
    return `[${a.isValue ? 'v' : 'k'}, ${a.id}]`
  }
  return `[${a.isRight}, ${a.isValue ? 'v' : 'k'}, ${a.id}]`
}
