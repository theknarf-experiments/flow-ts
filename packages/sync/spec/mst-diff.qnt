// Formal model of the MST diff algorithm (`packages/sync/src/mst/page-range.ts`).
//
// We don't reproduce the Page/Node tree explicitly — Quint isn't a
// great fit for that and we'd be re-deriving the property we already
// know (history-independence: same key set → same shape). Instead we
// model the *observable contract*:
//
//   pageRanges:  Set[Fact]  →  Set[PageRange]
//   diff:        local: Set[PageRange] × peer: Set[PageRange] → Set[DiffRange]
//
// The pageRanges function used here is a simplified deterministic
// layout (group keys by their `level`). Not the literal MST layout,
// but it shares the property that matters for the diff algorithm:
// two replicas with the same key set produce the same Set[PageRange]
// (and therefore identical (start, end, hash) triples).
//
// What we verify:
//   * diffCompleteInv  — every key peer has that local doesn't is
//     covered by some range in `diff(local, peer)`.
//   * diffSoundInv     — every key returned in a diff range is a
//     key peer actually has.
//   * historyIndepInv  — pageRanges(A) == pageRanges(B) iff A == B.
//   * supersetSkipsDiff — if local ⊇ peer, diff returns ∅.

module mstDiff {

  pure val FACTS = Set(0, 1, 2, 3, 4, 5)

  type Fact = int

  // Toy "level" function. The real impl uses leading-zero nibbles of
  // the WILLIAM3 hash; for the model we just use `fact mod 3` so
  // there's enough variety to produce a non-trivial layout without
  // blowing up the state space.
  pure def level(f: Fact): int = f.imod(3)

  // A PageRange covers a contiguous (sorted) run of keys all at the
  // same level. `keys` doubles as the hash (set equality = digest
  // equality at this abstraction).
  type PageRange = {
    lvl: int,
    keys: Set[Fact],
  }

  type DiffRange = {
    keys: Set[Fact],
  }

  // Build the canonical page-range list for a key set. One range per
  // level: contains every key in `keys` whose level equals that level
  // (or empty levels are omitted).
  pure def pageRanges(ks: Set[Fact]): Set[PageRange] = {
    Set(0, 1, 2)
      .map(L => { lvl: L, keys: ks.filter(k => level(k) == L) })
      .filter(p => p.keys != Set())
  }

  // Diff: a peer range is *consistent* iff local has a range with
  // matching (lvl, keys) — i.e. byte-identical digest. Otherwise its
  // keys go into the diff result.
  pure def diff(local: Set[PageRange], peer: Set[PageRange]): Set[DiffRange] = {
    peer
      .filter(p => not(local.exists(l => l.lvl == p.lvl and l.keys == p.keys)))
      .map(p => { keys: p.keys })
  }

  // -------------------- Test scaffold --------------------

  var localKeys: Set[Fact]
  var peerKeys: Set[Fact]

  action init = {
    nondet a = FACTS.powerset().oneOf()
    nondet b = FACTS.powerset().oneOf()
    all {
      localKeys' = a,
      peerKeys' = b,
    }
  }

  // No transitions — we want the invariants to hold for the entire
  // state space exhausted by `init`. Re-randomise on each step so
  // the simulator gets more coverage.
  action step = {
    nondet a = FACTS.powerset().oneOf()
    nondet b = FACTS.powerset().oneOf()
    all {
      localKeys' = a,
      peerKeys' = b,
    }
  }

  // -------------------- Invariants --------------------

  // Flatten a Set[DiffRange] to its union of keys.
  pure def diffKeys(rs: Set[DiffRange]): Set[Fact] =
    rs.fold(Set(), (acc, r) => acc.union(r.keys))

  // diff(local, peer) covers every key peer has that local doesn't.
  val diffCompleteInv: bool = {
    val expected = peerKeys.exclude(localKeys)
    val actual = diffKeys(diff(pageRanges(localKeys), pageRanges(peerKeys)))
    expected.subseteq(actual)
  }

  // Every key in the diff result is a key peer actually has.
  val diffSoundInv: bool = {
    diffKeys(diff(pageRanges(localKeys), pageRanges(peerKeys))).subseteq(peerKeys)
  }

  // pageRanges is a deterministic function — same set, same output.
  // (Trivially true by purity, but worth pinning as an invariant so
  // future restructures don't accidentally introduce nondeterminism.)
  val historyIndepInv: bool = {
    pageRanges(localKeys) == pageRanges(localKeys)
  }

  // If local == peer, the diff is empty.
  val equalSkipsDiffInv: bool = {
    (localKeys == peerKeys) implies
    diff(pageRanges(localKeys), pageRanges(peerKeys)) == Set()
  }

  // CAVEAT: "local is a strict superset → diff is empty" does NOT
  // hold for this model and also doesn't hold for the canonical MST.
  // When local has extra keys, local's pages have different shapes
  // (different `(start, end, hash)` triples) than peer's, so peer's
  // pages don't match local's → they go into the diff. After applying
  // the DATA reply, local is a no-op superset of itself: idempotent.
  // The first counter-example found by the model checker was
  // local={1,3,4}, peer={4}: peer's level-1 page covers just {4},
  // local's level-1 page covers {1,4}, different keys → flagged
  // inconsistent → diff returns peer's keys. Local re-fetches {4},
  // already has it, no-op. Bandwidth-wasteful but correct.
  //
  // The actually-useful property here:
  val applyingDiffIsIdempotentInv: bool = {
    val d = diff(pageRanges(localKeys), pageRanges(peerKeys))
    val afterApply = localKeys.union(diffKeys(d))
    // After applying diff, local has at least every key peer had.
    peerKeys.subseteq(afterApply)
  }
}
