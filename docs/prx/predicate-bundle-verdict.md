# ADR — `MergeabilityVerdict` as a policy over a predicate bundle (GH-592)

> Status: **proposed**. Sketches the follow-up to the predicate
> binding-semantics precursor (#591, merged: the binding tag,
> `RequiredPredicate`, the optional `requiredPredicates` bundle, and
> `requiredPredicatesOf()` in `packages/prx/src/machine/contracts.ts`).
> **Spec/design, not build** — and sequenced *behind* the intake-to-plan
> transition spec. Tracked by GH-592.

## Problem

Two problems, one mechanism.

**The merge verdict is a flat conjunction.** The operative gate today is
`canEnterReadyToMerge()` in
`packages/prx/src/machine/machines/workflow.ts` — `review === "approved" &&
ci === "passed" && provenance !== "unsigned"`. Three string axes, ANDed. It
can't express *which* predicates a given change requires, can't distinguish a
re-derivable property from a rubber-stampable assertion, and can't scale gate
strength to blast radius. A human "approved" and a hermetic "tests passed"
carry the same weight and the same shape.

**Everything is a serial per-UoW pipeline.** Each transition gates on exactly
one artifact (`requiredArtifact`/`requiredStatus`), so a work unit advances as
a single serial chain. Every predicate is a place the PR can wait; a
serialized multi-predicate gate just relocates the whip from the incident
column to the latency/WIP column (7+-day stalls). Adding reviewers *beside* the
human path doesn't help — only taking work *off* it does.

## The mechanism

Make the verdict a **function the policy computes over the typed predicate
bundle** that #591 introduced, where each member's binding (`property` vs
`event`) is also the axis the queues split on.

- **`property` members** — re-derivable hermetically against the head they name
  (a suite passed against H; I04 over a `RawStateV1`). No actor, no queue. They
  **fan out in parallel** and gate *entry* to human review: a change that fails
  them bounces to the author as a failed predicate, never reaching a person.
- **`event` members** — a re-attributable assertion that some actor produced an
  event over H (a non-author *findings* attestation; a human approval). These
  are the **only** members that enqueue, each against its producing actor's
  bounded queue. A UoW serializes *exactly* at its event members and nowhere
  else.

So "more queue architecture at each level" resolves to: **the queue is
per-binding, not per-UoW.** Serialization collapses onto the event members;
minimizing them minimizes serial latency.

## Decision

Four moves, in dependency order. (1)–(2) are the verdict; (3)–(4) are the
queue and its admission policy.

1. **`MergeabilityVerdict` = policy over `requiredPredicatesOf(contract)`.**
   Generalize `canEnterReadyToMerge` from a hardcoded conjunction into a
   verdict computed by policy over the bundle. The verdict is the function over
   the bundle — **no single event-predicate ever stands alone**.

2. **Per-binding evaluation.** `property` members are evaluated by
   re-derivation (re-run; true or not); `event` members contribute weighted
   assertions, never a unilateral clear.

3. **Per-actor queues for event members.** Each `event` member enqueues against
   its producing actor's bounded queue. `property` members never enqueue. This
   is the structural form of "added actors help only if they take work off the
   human path."

4. **Capability-footprint → required-predicate mapping (queue admission).** Map
   a change's capability footprint (blast radius) to the predicates it
   requires, reusing the monotone-matrix shape already in
   `packages/prx/src/agents/capability_envelope.ts` (`scope × reversibility →
   approval`) — but on the *change-footprint* axis rather than the *action*
   axis. This is drum-buffer-rope: the human/critic queue is the drum,
   footprint-gating is the rope throttling release into it.
   - A docs change requires no `event` predicate → clears on `property` members
     → never enters the human queue.
   - A credential-routing change requires a stronger, possibly multi-party
     `event` predicate → admitted to the queue, and only then.

   The verdict stops being "was it reviewed" and becomes "were the predicates
   required *for this blast radius* present."

## Costs (stated, not waved away)

- **Critic shares priors.** An `event` member from a critic carrying the author
  model's blind spots is weak evidence dressed as independent. Worth its weight
  only if genuinely differently-conditioned, and even then counted as one
  partial signal, not a clear.
- **Every predicate is a stall point.** The net comes out ahead only if
  `property` members run **parallel and fast** and the required `event`
  member is genuinely scoped down by footprint. Serialize them and this builds
  a cleaner bottleneck, not a faster path.

## The load-bearing assumption (falsifiable)

> The fraction of review effort that is mechanizable is large enough that
> gating on `property` predicates materially cuts human review-minutes per PR.

AI failures sit beneath the surface — exactly what tests and linters miss. If
most review cost is irreducible intent-reasoning, the bundle shrinks the queue
only at the margin and the senior-engineer tax persists. This is the claim the
design rises or falls on; it is stated so it can be measured, not assumed.

## The honest floor

A human attestation never means "code is sound" — only "actor X holding review
capability asserted P over H." Laundering is defeated not by making the human
honest but by **never letting a single event-predicate stand alone**: the
verdict is the policy function over the whole bundle.

## Sequencing

Behind the **intake-to-plan transition spec** (lower-risk, continues the
already-open lifecycle axis; depends on nothing here). This ADR carries the
higher-risk, empirically-loaded part. The #591 vocabulary
(`property`/`event`, `requiredPredicatesOf`) is the shared spine both target,
so neither blocks the other regardless of order.
