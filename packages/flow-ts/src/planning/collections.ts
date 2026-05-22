// Port of flowlog/src/planning/src/collections.rs

import type { AtomArgumentSignature, Catalog } from '../catalog/index.js'

/**
 * Identifier for a collection in the dataflow graph. The discriminant tracks
 * how the collection was produced; the `name` is the canonical string used
 * for equality/keying (matches the Rust derived PartialEq/Hash).
 */
export type CollectionSignature =
  | { kind: 'Atom'; name: string }
  | { kind: 'UnaryTransformationOutput'; name: string }
  | { kind: 'JnOutput'; name: string }
  | { kind: 'NegJnOutput'; name: string }

export function newAtomSignature(name: string): CollectionSignature {
  return { kind: 'Atom', name }
}

export function collectionSignatureName(s: CollectionSignature): string {
  return s.name
}

/**
 * Strip everything between `|` characters from the signature's name — the
 * Rust `debug_name` helper. Used to produce human-readable names that skip
 * the flow-pretty-printing detail.
 */
export function collectionSignatureDebugName(s: CollectionSignature): string {
  let skip = false
  let out = ''
  for (const c of s.name) {
    if (c === '|') {
      skip = !skip
    } else if (!skip) {
      out += c
    }
  }
  return out
}

export function collectionSignatureIsAtom(s: CollectionSignature): boolean {
  return s.kind === 'Atom'
}

export class Collection {
  constructor(
    public readonly signature: CollectionSignature,
    public readonly keyArgumentSignatures: AtomArgumentSignature[],
    public readonly valueArgumentSignatures: AtomArgumentSignature[],
  ) {}

  arity(): [number, number] {
    return [this.keyArgumentSignatures.length, this.valueArgumentSignatures.length]
  }

  isKv(): boolean {
    return this.keyArgumentSignatures.length > 0
  }

  isKOnly(): boolean {
    return this.valueArgumentSignatures.length === 0
  }

  pprint(): string {
    if (this.isKv()) {
      const ks = this.keyArgumentSignatures.map((s) => s.toString()).join(', ')
      const vs = this.valueArgumentSignatures.map((s) => s.toString()).join(', ')
      return `${this.signature.name}(${ks}: ${vs})`
    }
    const vs = this.valueArgumentSignatures.map((s) => s.toString()).join(', ')
    return `${this.signature.name}(${vs})`
  }

  /** Map argument string → first signature occurrence (key first, then value). */
  populateArgumentPresenceMap(catalog: Catalog): Map<string, AtomArgumentSignature> {
    const out = new Map<string, AtomArgumentSignature>()
    for (const sig of [...this.keyArgumentSignatures, ...this.valueArgumentSignatures]) {
      const argStr = catalog.signatureToArgumentStrMap.get(sig)
      if (argStr === undefined) {
        throw new Error(
          `populateArgumentPresenceMap: ${sig.toString()} absent from catalog map`,
        )
      }
      if (!out.has(argStr)) out.set(argStr, sig)
    }
    return out
  }
}
