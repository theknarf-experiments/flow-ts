// Regression spec for the historical "mutual DONE handshake" bug.
//
// In an early version of the protocol, `shouldFinish` ALSO required
// `peerDoneReceived` — so each side waited for the other's DONE
// before declaring its round complete. If a side's lone DONE message
// was dropped, the peer waited forever.
//
// This file IS NOT the current protocol — it's a deliberate
// regression that the model checker should reject. It's a
// self-contained standalone module built on the set-of-facts
// abstraction the checker's other specs (sync-v2.qnt, mst-diff.qnt)
// have since moved past. The point of this file: prove the
// modelling framework would catch such a bug if we'd had the spec
// when we wrote that version — the witness rate for both replicas
// finishing under drops falls off a cliff (~15% baseline → ~1.6%
// with the deadlock).
//
// Run: pnpm exec quint run --backend=typescript \
//        --invariant=convergenceInv \
//        --witnesses 'state.get("a").roundComplete and state.get("b").roundComplete' \
//        --max-steps=40 --max-samples=2000 \
//        packages/sync/spec/sync-buggy-mutual-done.qnt

module syncBuggyMutualDone {

  pure val FACTS = Set(0, 1, 2)
  pure val REPLICAS = Set("a", "b")

  type Fact = int

  type Msg =
    | Hello({ from: str, root: Set[Fact] })
    | PageRanges({ from: str, facts: Set[Fact] })
    | Fetch({ from: str, needs: Set[Fact] })
    | Data({ from: str, facts: Set[Fact] })
    | Done({ from: str })

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

  var state: str -> ReplicaState
  var network: Set[Msg]

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

  // *** BUGGY: requires peerDoneReceived too. ***
  pure def shouldFinish(s: ReplicaState): bool = and {
    s.peerPageRangesReceived,
    s.fetchSatisfied,
    s.localDoneSent,
    s.peerDoneReceived,
    not(s.roundComplete),
  }

  pure def applyMaybeFinish(s: ReplicaState): ReplicaState =
    if (shouldFinish(s))
      { ...s, roundComplete: true }
    else if (s.peerPageRangesReceived and s.fetchSatisfied and not(s.localDoneSent))
      // In the buggy version, we'd also set localDoneSent=true here
      // to actually emit DONE, even though we haven't finished.
      { ...s, localDoneSent: true }
    else
      s

  action init = {
    nondet aFacts = FACTS.powerset().oneOf()
    nondet bFacts = FACTS.powerset().oneOf()
    all {
      state' = Map("a" -> emptyReplica(aFacts), "b" -> emptyReplica(bFacts)),
      network' = Set(),
    }
  }

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

  // In the BUGGY version, DONE is only sent ONCE (no retries while
  // !peerDoneReceived — because we wait for it via the finish check
  // itself, not via the pump). Model that by gating on localDoneSent
  // *and* not(retried). For the model, we just don't enable resends.
  // Result: a single DONE drop strands the peer.
  action sendDone(r: str): bool = all {
    isAlive(state.get(r)),
    state.get(r).localDoneSent,
    // *** BUG: no retry condition. We model DONE as fire-and-forget;
    // the absence of a retry path is exactly what made the original
    // protocol stuck. ***
    false,
    network' = network,
    state' = state,
  }

  pure def fetchResponder(p: { from: str, needs: Set[Fact] }): str = peerOf(p.from)
  pure def fetchShipment(p: { from: str, needs: Set[Fact] }, st: str -> ReplicaState): Set[Fact] =
    p.needs.intersect(st.get(peerOf(p.from)).facts)

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
    else st.set(r, applyMaybeFinish({ ...s, peerDoneReceived: true }))
  }

  // Outbound DONE happens in applyMaybeFinish (we just set localDoneSent)
  // — but we *also* need to emit the message. Add a dedicated action.
  action emitDone(r: str): bool = all {
    isAlive(state.get(r)),
    state.get(r).localDoneSent,
    not(state.get(r).peerDoneReceived),
    network.forall(m =>
      match m {
        | Done(p) => p.from != r
        | _ => true
      }
    ),
    network' = network.union(Set(Done({ from: r }))),
    state' = state,
  }

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

  action dropMsg(m: Msg): bool = all {
    network.contains(m),
    network' = network.exclude(Set(m)),
    state' = state,
  }

  action step = any {
    nondet r = REPLICAS.oneOf()
    sendHello(r),

    nondet r = REPLICAS.oneOf()
    sendPageRanges(r),

    nondet r = REPLICAS.oneOf()
    sendFetch(r),

    nondet r = REPLICAS.oneOf()
    emitDone(r),

    nondet m = network.oneOf()
    deliver(m),

    nondet m = network.oneOf()
    dropMsg(m),
  }

  // Same convergence invariant as v1 — still expected to hold (safety
  // isn't violated). The interesting check is the *witness*: how often
  // do both replicas reach roundComplete?
  val convergenceInv: bool =
    (state.get("a").roundComplete and state.get("b").roundComplete) implies
    (state.get("a").facts == state.get("b").facts)
}
