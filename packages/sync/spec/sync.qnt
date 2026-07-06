// Formal model of the @flow-ts/sync session protocol.
//
// Protocol shape: HELLO → PAGE_RANGES → FETCH → DATA → DONE, plus
// post-round PUSH gossip. Modeling choices:
//   * PAGE_RANGES carries an actual list of (start, end, hash)
//     triples — `Set[PageRange]` — derived deterministically from
//     the sender's fact set via `pageRanges()`.
//   * The receiver runs the real diff function over its own and
//     peer's page lists, producing `Set[DiffRange]` (inclusive
//     fact ranges).
//   * FETCH carries those `Set[DiffRange]` ranges; the responder
//     extracts the keys those ranges cover from its own facts.
//   * PUSH carries new facts post-round; dropMsg gate makes PUSH
//     eventually-delivered (mirrors the impl's at-least-once
//     PUSH_ACK retry loop).
//
// The page-range layout is the same toy model as `mst-diff.qnt`:
// group keys by `level = fact mod 3`. Not a literal MST tree, but
// it shares the load-bearing property — deterministic from the
// fact set — and lets us verify diff completeness/soundness inside
// the protocol flow under an adversarial network.

module sync {

  // -------------------- Constants --------------------

  pure val FACTS = Set(0, 1, 2, 3, 4)

  pure val REPLICAS = Set("a", "b")

  // -------------------- Types --------------------

  type Fact = int

  // A page covers a contiguous-in-`level`-and-bytes block of keys.
  // `digest` is just the set of covered keys; equality of `digest`
  // = equality of covered key set (which is what real digests
  // commit to anyway).
  type PageRange = {
    start: Fact,
    end: Fact,
    digest: Set[Fact],
  }

  // A range of keys local needs to fetch from peer.
  type DiffRange = {
    start: Fact,
    end: Fact,
  }

  type Msg =
    | Hello({ from: str, root: Set[Fact] })
    | PageRanges({ from: str, pages: Set[PageRange] })
    | Fetch({ from: str, ranges: Set[DiffRange] })
    | Data({ from: str, facts: Set[Fact] })
    | Done({ from: str })
    // Post-PAGE_RANGES gossip. The engine layer fires Push on every
    // local add() to every attached peer (regardless of whether
    // the peer's initial reconcile has completed). The session
    // handles Push at any time after start().
    | Push({ from: str, facts: Set[Fact] })

  type ReplicaState = {
    facts: Set[Fact],
    helloReceived: bool,
    pageRangesSent: bool,
    peerPageRangesReceived: bool,
    peerPages: Set[PageRange],
    pendingFetch: Set[DiffRange],
    fetchIssued: bool,
    fetchSatisfied: bool,
    localDoneSent: bool,
    peerDoneReceived: bool,
    roundComplete: bool,
    failed: bool,
  }

  // -------------------- Variables --------------------

  var state: str -> ReplicaState
  var network: Set[Msg]

  // -------------------- MST primitives (same as mst-diff.qnt) --------------------

  pure def levelOf(f: Fact): int = f % 3

  // Build canonical page ranges for a fact set. Groups keys by level;
  // each group becomes one PageRange spanning that level's min..max
  // key with digest = the group itself.
  pure def pageRanges(fs: Set[Fact]): Set[PageRange] = {
    Set(0, 1, 2).map(lvl => {
      val group = fs.filter(f => levelOf(f) == lvl)
      if (group == Set())
        { start: -1, end: -1, digest: Set() }
      else
        { start: group.fold(99, (a, b) => if (a < b) a else b),
          end: group.fold(-1, (a, b) => if (a > b) a else b),
          digest: group }
    }).filter(p => p.digest != Set())
  }

  // Diff: peer pages whose (start, end, digest) don't appear in local.
  pure def diff(localPages: Set[PageRange], peerPages: Set[PageRange]): Set[DiffRange] = {
    peerPages.filter(p => not(localPages.exists(lp =>
      lp.start == p.start and lp.end == p.end and lp.digest == p.digest
    ))).map(p => { start: p.start, end: p.end })
  }

  // Keys in `facts` whose value lies in any of the given inclusive ranges.
  pure def keysInRanges(facts: Set[Fact], ranges: Set[DiffRange]): Set[Fact] =
    facts.filter(f => ranges.exists(r => f >= r.start and f <= r.end))

  // -------------------- Helpers --------------------

  pure def emptyReplica(initial: Set[Fact]): ReplicaState = {
    facts: initial,
    helloReceived: false,
    pageRangesSent: false,
    peerPageRangesReceived: false,
    peerPages: Set(),
    pendingFetch: Set(),
    fetchIssued: false,
    fetchSatisfied: false,
    localDoneSent: false,
    peerDoneReceived: false,
    roundComplete: false,
    failed: false,
  }

  pure def peerOf(r: str): str = if (r == "a") "b" else "a"

  pure def isAlive(s: ReplicaState): bool = not(s.failed)

  pure def shouldFinish(s: ReplicaState): bool = and {
    s.peerPageRangesReceived,
    s.fetchSatisfied,
    not(s.roundComplete),
  }

  pure def applyMaybeFinish(s: ReplicaState): ReplicaState =
    if (shouldFinish(s))
      { ...s, roundComplete: true, localDoneSent: true }
    else
      s

  // -------------------- Initial state --------------------

  action init = {
    nondet aFacts = FACTS.powerset().oneOf()
    nondet bFacts = FACTS.powerset().oneOf()
    all {
      state' = Map("a" -> emptyReplica(aFacts), "b" -> emptyReplica(bFacts)),
      // Pre-load both HELLOs into the network — matches the impl's
      // `start()` which unconditionally fires sendHello. Without this,
      // the model could explore traces where B never sends HELLO,
      // which lets B fast-path-complete without A getting any
      // notification, producing spurious convergence violations.
      network' = Set(
        Hello({ from: "a", root: aFacts }),
        Hello({ from: "b", root: bFacts }),
      ),
    }
  }

  // -------------------- Outbound actions --------------------

  action sendHello(r: str): bool = all {
    isAlive(state.get(r)),
    not(state.get(r).roundComplete),
    network' = network.union(Set(Hello({ from: r, root: state.get(r).facts }))),
    state' = state,
  }

  action sendPageRanges(r: str): bool = all {
    isAlive(state.get(r)),
    state.get(r).pageRangesSent,
    not(state.get(r).peerDoneReceived),
    network' = network.union(Set(PageRanges({
      from: r,
      pages: pageRanges(state.get(r).facts),
    }))),
    state' = state,
  }

  action sendFetch(r: str): bool = all {
    isAlive(state.get(r)),
    state.get(r).fetchIssued,
    state.get(r).pendingFetch != Set(),
    not(state.get(r).fetchSatisfied),
    network' = network.union(Set(Fetch({
      from: r,
      ranges: state.get(r).pendingFetch,
    }))),
    state' = state,
  }

  action sendDone(r: str): bool = all {
    isAlive(state.get(r)),
    state.get(r).localDoneSent,
    not(state.get(r).peerDoneReceived),
    network' = network.union(Set(Done({ from: r }))),
    state' = state,
  }

  // -------------------- Inbound handlers --------------------

  pure def onHello(r: str, peerRoot: Set[Fact], st: str -> ReplicaState): str -> ReplicaState = {
    val s = st.get(r)
    if (not(isAlive(s))) st
    else if (s.facts == peerRoot)
      st.set(r, applyMaybeFinish({
        ...s,
        helloReceived: true,
        pageRangesSent: true,
        peerPageRangesReceived: true,
        fetchSatisfied: true,
        fetchIssued: true,
      }))
    else
      st.set(r, applyMaybeFinish({
        ...s,
        helloReceived: true,
        pageRangesSent: true,
      }))
  }

  pure def onPageRanges(r: str, peerPages: Set[PageRange], st: str -> ReplicaState): str -> ReplicaState = {
    val s = st.get(r)
    if (not(isAlive(s))) st
    else {
      val myPages = pageRanges(s.facts)
      val need = diff(myPages, peerPages)
      val updated =
        if (not(s.fetchIssued))
          // First PAGE_RANGES from this peer: standard FETCH path.
          {
            ...s,
            peerPageRangesReceived: true,
            peerPages: peerPages,
            pendingFetch: need,
            fetchIssued: true,
            fetchSatisfied: if (need == Set()) true else s.fetchSatisfied,
          }
        else if (need == Set())
          // Subsequent PAGE_RANGES with nothing new: idempotent no-op.
          { ...s, peerPageRangesReceived: true, peerPages: peerPages }
        else
          // Subsequent PAGE_RANGES claims keys we haven't fetched.
          // Re-engage: reset fetchSatisfied + roundComplete so the
          // FETCH cycle runs again. Matches the
          // post-`peerPageRangesReceived` branch in session.ts.
          {
            ...s,
            peerPageRangesReceived: true,
            peerPages: peerPages,
            pendingFetch: need,
            fetchSatisfied: false,
            roundComplete: false,
          }
      st.set(r, applyMaybeFinish(updated))
    }
  }

  pure def onData(r: str, facts: Set[Fact], st: str -> ReplicaState): str -> ReplicaState = {
    val s = st.get(r)
    if (not(isAlive(s))) st
    else if (s.fetchSatisfied) st
    else
      st.set(r, applyMaybeFinish({
        ...s,
        facts: s.facts.union(facts),
        fetchSatisfied: true,
      }))
  }

  pure def onDone(r: str, st: str -> ReplicaState): str -> ReplicaState = {
    val s = st.get(r)
    if (not(isAlive(s))) st
    else st.set(r, { ...s, peerDoneReceived: true })
  }

  pure def onPush(r: str, facts: Set[Fact], st: str -> ReplicaState): str -> ReplicaState = {
    val s = st.get(r)
    if (not(isAlive(s))) st
    // Push is unconditional — apply at any time after start.
    else st.set(r, { ...s, facts: s.facts.union(facts) })
  }

  pure def fetchResponder(p: { from: str, ranges: Set[DiffRange] }): str = peerOf(p.from)

  pure def fetchShipment(p: { from: str, ranges: Set[DiffRange] }, st: str -> ReplicaState): Set[Fact] =
    keysInRanges(st.get(fetchResponder(p)).facts, p.ranges)

  action deliver(m: Msg): bool = all {
    network.contains(m),
    match m {
      | Hello(p) => all {
          network' = network.exclude(Set(m)),
          state' = onHello(peerOf(p.from), p.root, state),
        }
      | PageRanges(p) => all {
          network' = network.exclude(Set(m)),
          state' = onPageRanges(peerOf(p.from), p.pages, state),
        }
      | Fetch(p) => all {
          isAlive(state.get(fetchResponder(p))),
          network' = network.exclude(Set(m)).union(Set(Data({
            from: fetchResponder(p),
            facts: fetchShipment(p, state),
          }))),
          state' = state,
        }
      | Data(p) => all {
          network' = network.exclude(Set(m)),
          state' = onData(peerOf(p.from), p.facts, state),
        }
      | Done(p) => all {
          network' = network.exclude(Set(m)),
          state' = onDone(peerOf(p.from), state),
        }
      | Push(p) => all {
          network' = network.exclude(Set(m)),
          state' = onPush(peerOf(p.from), p.facts, state),
        }
    }
  }

  // Msg-type predicate used to gate dropMsg. Push is modelled as
  // reliable (the impl provides at-least-once via PUSH_ACK + pump
  // retries; the spec abstracts that into "delivery eventually
  // happens"). Without this gate, a single dropped Push lost the
  // fact for the round, which is the original v1 design that the
  // PUSH_ACK retry layer was added to fix.
  pure def isPush(m: Msg): bool = match m {
    | Push(_) => true
    | Hello(_) => false
    | PageRanges(_) => false
    | Fetch(_) => false
    | Data(_) => false
    | Done(_) => false
  }

  action dropMsg(m: Msg): bool = all {
    network.contains(m),
    not(isPush(m)),
    network' = network.exclude(Set(m)),
    state' = state,
  }

  // Local write. Models `engine.add(rel, row)`: the fact is added
  // to r's facts and a Push message is sent to the peer. Mirrors
  // the engine's behavior of pushing to every attached peer on
  // every add, regardless of whether the peer's session is in
  // initial reconcile or post-round.
  action addLocalFact(r: str, f: Fact): bool = all {
    isAlive(state.get(r)),
    not(state.get(r).facts.contains(f)),
    state' = state.set(r, { ...state.get(r), facts: state.get(r).facts.union(Set(f)) }),
    network' = network.union(Set(Push({ from: r, facts: Set(f) }))),
  }

  // -------------------- Top-level step --------------------

  action step = any {
    nondet r = REPLICAS.oneOf()
    sendHello(r),

    nondet r = REPLICAS.oneOf()
    sendPageRanges(r),

    nondet r = REPLICAS.oneOf()
    sendFetch(r),

    nondet r = REPLICAS.oneOf()
    sendDone(r),

    nondet m = network.oneOf()
    deliver(m),

    nondet m = network.oneOf()
    dropMsg(m),

    nondet r = REPLICAS.oneOf()
    nondet f = FACTS.oneOf()
    addLocalFact(r, f),
  }

  // -------------------- Invariants --------------------

  // Eventual consistency: when there are no more in-flight messages
  // AND both replicas have completed their round AND no further
  // writes are pending, fact sets are equal. `roundComplete` alone
  // doesn't imply convergence — it means "my local conditions are
  // met," not "all retransmits have been observed." With PUSH and
  // PAGE_RANGES retries, messages can stay in flight after either
  // replica's round is locally done.
  val convergenceInv: bool =
    (network == Set() and
     state.get("a").roundComplete and
     state.get("b").roundComplete and
     state.get("a").peerDoneReceived and
     state.get("b").peerDoneReceived)
    implies (state.get("a").facts == state.get("b").facts)

  // Round-complete preconditions.
  val finishInvariantInv: bool =
    REPLICAS.forall(r => {
      val s = state.get(r)
      s.roundComplete implies and {
        s.peerPageRangesReceived,
        s.fetchSatisfied,
        s.localDoneSent,
      }
    })

  // In the steady state — network drained, both rounds locally
  // complete, both DONE acknowledged — the page-range layouts must
  // match. (Implied by convergenceInv but useful as a redundant
  // check since pageRanges is deterministic from the fact set.)
  val noMissedKeysInv: bool =
    (network == Set() and
     state.get("a").roundComplete and
     state.get("b").roundComplete and
     state.get("a").peerDoneReceived and
     state.get("b").peerDoneReceived)
    implies (pageRanges(state.get("a").facts) == pageRanges(state.get("b").facts))
}
