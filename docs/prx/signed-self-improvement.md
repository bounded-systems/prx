# ADR — eval-gated prompt evolution as a signed derivation

> **Status:** proposed (spike proven) &nbsp;·&nbsp; **Bead:** `prx-75m`
> **Spike:** [`docs/spikes/signed-prompt-evolution/`](../spikes/signed-prompt-evolution/) (runnable POC)

## Context

A long-running agent that edits its own instructions is useful and dangerous. Useful,
because the same class of task recurs and the lessons from one run should carry to the
next. Dangerous, because letting a model rewrite its own system prompt on a live run is a
direct path to drift, regression, and injected instructions surviving as "remembered
truth."

Prior art — the [`long-running-agent` / lra](https://github.com/FareedKhan-dev/long-running-agent)
project — handles the danger with an **offline, eval-gated** loop: an evolver proposes an
improved prompt from failure traces, the candidate is scored against held-out gold cases
by an independent judge, and it is promoted only if it beats the baseline. A live prompt is
never hot-patched. That discipline is sound and worth adopting.

It does not, however, make the promotion **tamper-evident**. lra content-addresses large
payloads (SHA-256) but the promotion decision itself is not signed, so nothing downstream
can independently prove that a given live prompt is the output of a passing evaluation
rather than an arbitrary edit.

## Decision

Adopt the eval-gated loop, and make the **promotion a signed `anchored-chain` derivation.**

- A promotion is a `Derivation` whose manifest binds **inputs** `{ baselinePrompt,
  failureTraces, evalReport }` (by digest) to the **output** `{ candidatePrompt }` (by
  digest), under a `eval-gated-promotion@1` contract.
- The canonical manifest is signed with ed25519 via the chain's DSSE seam
  (`dssePae` → `Signer.sign`).
- The live prompt registry swaps in a candidate **only if** (a) the promotion's signature
  verifies and (b) the signed output digest matches the prompt being installed.

The invariant, stated as a rule: **no signed promotion → no swap.** An unsigned, tampered,
or wrong-key promotion is rejected at the swap boundary by cryptography — not by policy
text or a prompt the model could talk around.

## Rationale

| Approach | Eval-gated | Survives the process | Tamper-evident | Staleness propagates |
|----------|:--:|:--:|:--:|:--:|
| Prompt-as-config (hand-edited) | — | ✅ | — | — |
| Eval-gated, content-addressed (lra) | ✅ | ✅ | — | — |
| **Eval-gated, signed derivation (this ADR)** | ✅ | ✅ | ✅ | ✅ (via `DerivationStore`) |

Signing is the increment that buys the last two columns. Because the promotion is a node
in the same derivation graph prx already uses for build/CI provenance, a prompt whose input
failure-traces are later invalidated can be marked **stale** and re-gated automatically —
something a one-shot content hash cannot express. This is the same move SLSA/in-toto make
for build provenance, applied to *prompt* provenance.

## The spike (proven)

[`docs/spikes/signed-prompt-evolution/poc.ts`](../spikes/signed-prompt-evolution/poc.ts) is
a ~190-line, deterministic, offline ($0) proof using the real chain primitives
(`generateEd25519Keypair`, `ed25519Signer`/`ed25519Verifier`, `dssePae`, `digestManifest`,
`Derivation`). Its run shows the gate accepting a winning candidate, signing the promotion,
and then **denying** both a tampered candidate (output-digest mismatch) and a forged-key
signature — so no unsigned mutation reaches the live prompt. A weak candidate that does not
beat baseline is rejected and nothing is signed.

## Open questions / next steps

- Replace the stub evolver + judge with a `ModelProvider` behind the same gate (mirrors
  lra's pluggable-backend design); keep the offline stub for deterministic CI.
- Persist promotions via a `DerivationStore` so the lineage/invalidation machinery
  (`isStale`, `invalidateDescendants`) drives automatic re-gating.
- Decide whether promotion additionally requires a human-approved gate for
  production-facing roles (the chain already models capability-gated approval).

## Links

- Bead: `prx-75m`
- Substrate: `@bounded-systems/anchored-chain` (`Derivation`, DSSE signing, lineage)
- Prior art: `long-running-agent` (eval-gated self-improvement, durable agents)
