// Formal model of the @flow-ts/sync session protocol.
//
// Two replicas, each with a Set[Fact] of facts. They reconcile via a
// HELLO / PAGE_RANGES / FETCH / DATA / DONE exchange over an
// unreliable, reordering network.
//
// Abstractions vs the TS implementation:
//   * The MST is replaced by `Set[Fact]`. Two replicas' "MST roots
//     match" iff their fact sets are equal — same property in our
//     implementation, just modelled directly.
//   * PAGE_RANGES is modelled as "I send you my entire fact set."
//     In the real protocol this is a list of (start, end, hash)
//     triples that the receiver diffs locally; for protocol-level
//     properties (safety, liveness, no-deadlock) the receiver
//     learning the sender's key set is enough.
//   * No retries / timers. Every action is non-deterministically
//     re-enabled while its precondition holds, which captures the
//     "pump keeps retrying" semantics without modelling time.

module sync {

  // -------------------- Constants --------------------

  // Bounded fact universe. Keep small for model-checking.
  pure val FACTS = Set(0, 1, 2)

  pure val REPLICAS = Set("a", "b")

  // -------------------- Types --------------------

  type Fact = int

  type Msg =
    | Hello({ from: str, root: Set[Fact] })
    | PageRanges({ from: str, facts: Set[Fact] })
    | Fetch({ from: str, needs: Set[Fact] })
    | Data({ from: str, facts: Set[Fact] })
    | Done({ from: str })

  // Per-replica state. Fields mirror `session.ts` 1-for-1:
  //   facts                 — keys held; grows on Data arrival.
  //   helloReceived         — peer HELLO arrived.
  //   pageRangesSent        — we sent PAGE_RANGES at least once.
  //   peerPageRangesReceived — peer PAGE_RANGES arrived.
  //   peerFacts             — snapshot of peer's facts from last PAGE_RANGES.
  //   pendingFetch          — keys we asked peer to ship; Set() = none.
  //   fetchIssued           — true once we computed our FETCH (or "no need").
  //   fetchSatisfied        — true once peer's DATA arrived (or no need).
  //   localDoneSent         — we sent DONE.
  //   peerDoneReceived      — peer DONE arrived.
  //   roundComplete         — local view of completion.
  //   failed                — transport closed externally; dead.
  type ReplicaState = {
    facts: Set[Fact],
    helloReceived: bool,
    pageRangesSent: bool,
    peerPageRangesReceived: bool,
    peerFacts: Set[Fact],
    pendingFetch: Set[Fact],
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

  // -------------------- Helpers --------------------

  pure def emptyReplica(initial: Set[Fact]): ReplicaState = {
    facts: initial,
    helloReceived: false,
    pageRangesSent: false,
    peerPageRangesReceived: false,
    peerFacts: Set(),
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
      network' = Set(),
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
    network' = network.union(Set(PageRanges({ from: r, facts: state.get(r).facts }))),
    state' = state,
  }

  action sendFetch(r: str): bool = all {
    isAlive(state.get(r)),
    state.get(r).fetchIssued,
    state.get(r).pendingFetch != Set(),
    not(state.get(r).fetchSatisfied),
    network' = network.union(Set(Fetch({ from: r, needs: state.get(r).pendingFetch }))),
    state' = state,
  }

  action sendDone(r: str): bool = all {
    isAlive(state.get(r)),
    state.get(r).localDoneSent,
    not(state.get(r).peerDoneReceived),
    network' = network.union(Set(Done({ from: r }))),
    state' = state,
  }

  // -------------------- Inbound: deliver one message --------------------

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

  pure def onPageRanges(r: str, peerFacts: Set[Fact], st: str -> ReplicaState): str -> ReplicaState = {
    val s = st.get(r)
    if (not(isAlive(s))) st
    else {
      val need = peerFacts.exclude(s.facts)
      val updated = if (s.fetchIssued)
        { ...s, peerPageRangesReceived: true, peerFacts: peerFacts }
      else
        {
          ...s,
          peerPageRangesReceived: true,
          peerFacts: peerFacts,
          pendingFetch: need,
          fetchIssued: true,
          fetchSatisfied: if (need == Set()) true else s.fetchSatisfied,
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

  // FETCH responder helpers (hoisted as pure defs so they're visible
  // inside the action's `all {}` block — local `val`s aren't scoped
  // across conjuncts in Quint).
  pure def fetchResponder(p: { from: str, needs: Set[Fact] }): str = peerOf(p.from)

  pure def fetchShipment(p: { from: str, needs: Set[Fact] }, st: str -> ReplicaState): Set[Fact] =
    p.needs.intersect(st.get(peerOf(p.from)).facts)

  // Deliver a message: route to the correct handler. FETCH is special:
  // delivery removes it from the network *and* the receiver immediately
  // emits a DATA response.
  action deliver(m: Msg): bool = all {
    network.contains(m),
    match m {
      | Hello(p) => all {
          network' = network.exclude(Set(m)),
          state' = onHello(peerOf(p.from), p.root, state),
        }
      | PageRanges(p) => all {
          network' = network.exclude(Set(m)),
          state' = onPageRanges(peerOf(p.from), p.facts, state),
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
    }
  }

  // -------------------- Adversary: drop / partition --------------------

  action dropMsg(m: Msg): bool = all {
    network.contains(m),
    network' = network.exclude(Set(m)),
    state' = state,
  }

  action triggerClose(r: str): bool = all {
    isAlive(state.get(r)),
    not(state.get(r).roundComplete),
    state' = state.set(r, { ...state.get(r), failed: true }),
    network' = network,
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
  }

  // -------------------- Invariants --------------------

  // Safety: if both replicas have completed their round, their fact
  // sets are equal.
  val convergenceInv: bool =
    (state.get("a").roundComplete and state.get("b").roundComplete) implies
    (state.get("a").facts == state.get("b").facts)

  // roundComplete is well-formed: it only flips true when the
  // local-completion preconditions held.
  val finishInvariantInv: bool =
    REPLICAS.forall(r => {
      val s = state.get(r)
      s.roundComplete implies and {
        s.peerPageRangesReceived,
        s.fetchSatisfied,
        s.localDoneSent,
      }
    })

  // A round-completed replica must contain every fact peer had at
  // the time of the last PAGE_RANGES we processed.
  val pulledEverythingInv: bool =
    REPLICAS.forall(r => {
      val s = state.get(r)
      s.roundComplete implies s.peerFacts.subseteq(s.facts)
    })
}
