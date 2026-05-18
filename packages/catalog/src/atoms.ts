// Port of flowlog/src/catalog/src/atoms.rs
//
// Plus two collection helpers — SignatureMap and SignatureSet — which let us
// key Maps/Sets by signature value (the Rust HashMap/HashSet equivalent).
// Object identity won't work for JS Maps, so each signature carries a
// pre-computed canonical `key` string.

/** Identifies a rule body atom (positive or negated) by its index. */
export class AtomSignature {
  /** Canonical key — matches the Rust Display form: `1` or `!1`. */
  readonly key: string

  constructor(
    public readonly isPositive: boolean,
    public readonly rhsId: number,
  ) {
    this.key = `${isPositive ? '' : '!'}${rhsId}`
  }

  toString(): string {
    return this.key
  }
}

/** Identifies a specific argument position inside a rule body atom. */
export class AtomArgumentSignature {
  /** Canonical key — matches the Rust Display form: `1.0` or `!1.0`. */
  readonly key: string

  constructor(
    public readonly atomSignature: AtomSignature,
    public readonly argumentId: number,
  ) {
    this.key = `${atomSignature.key}.${argumentId}`
  }

  isPositive(): boolean {
    return this.atomSignature.isPositive
  }

  toString(): string {
    return this.key
  }
}

/**
 * Map keyed by AtomArgumentSignature value (not object identity). Iteration
 * yields the original signature objects so callers can reconstruct context.
 */
export class SignatureMap<V> implements Iterable<[AtomArgumentSignature, V]> {
  private readonly inner = new Map<
    string,
    { sig: AtomArgumentSignature; value: V }
  >()

  get size(): number {
    return this.inner.size
  }

  get(sig: AtomArgumentSignature): V | undefined {
    return this.inner.get(sig.key)?.value
  }

  set(sig: AtomArgumentSignature, value: V): this {
    this.inner.set(sig.key, { sig, value })
    return this
  }

  has(sig: AtomArgumentSignature): boolean {
    return this.inner.has(sig.key)
  }

  delete(sig: AtomArgumentSignature): boolean {
    return this.inner.delete(sig.key)
  }

  *entries(): IterableIterator<[AtomArgumentSignature, V]> {
    for (const { sig, value } of this.inner.values()) yield [sig, value]
  }

  *keys(): IterableIterator<AtomArgumentSignature> {
    for (const { sig } of this.inner.values()) yield sig
  }

  *values(): IterableIterator<V> {
    for (const { value } of this.inner.values()) yield value
  }

  [Symbol.iterator](): Iterator<[AtomArgumentSignature, V]> {
    return this.entries()
  }

  isEmpty(): boolean {
    return this.inner.size === 0
  }
}

/** Set of AtomArgumentSignature values (keyed by canonical string). */
export class SignatureSet implements Iterable<AtomArgumentSignature> {
  private readonly inner = new Map<string, AtomArgumentSignature>()

  get size(): number {
    return this.inner.size
  }

  isEmpty(): boolean {
    return this.inner.size === 0
  }

  has(sig: AtomArgumentSignature): boolean {
    return this.inner.has(sig.key)
  }

  add(sig: AtomArgumentSignature): this {
    this.inner.set(sig.key, sig)
    return this
  }

  delete(sig: AtomArgumentSignature): boolean {
    return this.inner.delete(sig.key)
  }

  *values(): IterableIterator<AtomArgumentSignature> {
    yield* this.inner.values()
  }

  [Symbol.iterator](): Iterator<AtomArgumentSignature> {
    return this.values()
  }
}
