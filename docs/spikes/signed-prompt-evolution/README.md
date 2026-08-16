# Spike — eval-gated prompt evolution as a signed derivation

> **Type:** code spike / POC &nbsp;·&nbsp; **ADR:** [`docs/prx/signed-self-improvement.md`](../../prx/signed-self-improvement.md) &nbsp;·&nbsp; **Bead:** `prx-75m`

A ~190-line runnable proof that combines two ideas:

- **Eval-gated self-improvement** (prior art: the [`long-running-agent` / lra](https://github.com/FareedKhan-dev/long-running-agent)
  project): propose an improved prompt from failure traces, score candidate vs baseline on
  gold cases, promote only if it wins, and never hot-patch a live prompt.
- **Signed promotion** (prx's `@bounded-systems/anchored-chain`): the promotion is a
  **signed derivation**. The live prompt registry refuses to swap in a candidate unless
  presented with a promotion whose **ed25519 signature verifies** over the canonical
  manifest and whose signed output digest matches the prompt being installed.

lra content-addresses (SHA-256) but does not sign. Signing makes the promotion an
unforgeable capability, cryptographically bound to its inputs (baseline prompt + failure
traces + eval report) → output (candidate prompt). **No signed promotion → no swap.**

Everything is deterministic and offline ($0): stub evolver, stub judge, and the **real**
ed25519 primitives from the production chain (`generateEd25519Keypair`,
`ed25519Signer`/`ed25519Verifier`, `dssePae`, `digestManifest`, `Derivation`).

## Run

```sh
bun docs/spikes/signed-prompt-evolution/poc.ts
```

## Output

```
── eval-gated, signed prompt evolution ─────────────────────────────
keyid=263449e0606da1de…  cases=2

eval.run        baseline=0.00 candidate=1.00
promotion.gate  PASS (candidate >= baseline)
evolve.sign     derivation=sha256:58d16… signed
registry.swap   OK — installed (derivation sha256:58d16…)
tamper.attempt  DENIED — candidate prompt does not match signed output digest
forged.key      DENIED — signature does not verify

eval.run        baseline=0.00 weak=0.00
promotion.gate  REJECT — no signature minted, no swap

── final ───────────────────────────────────────────────────────────
live prompt advanced: true
clean: no unsigned mutation reached the live prompt
```

## What it shows

1. **Eval-gating** is small — a candidate swaps in only when it beats baseline on gold
   cases; a weak candidate is rejected and nothing is signed.
2. **The signature is the boundary** — a tampered candidate (output-digest mismatch) and a
   forged-key signature are both *denied at the swap*, by cryptography, not by policy or
   prompt. No unsigned mutation reaches the live prompt.

## Caveats / next steps

- Stub evolver + judge are deterministic placeholders; the real loop swaps in a
  `ModelProvider` behind the same gate.
- This spike assembles the `Derivation` + DSSE envelope against the chain's low-level
  primitives. Productionizing means persisting the promotion via a `DerivationStore` so
  staleness/invalidation propagates (a prompt whose input traces are invalidated goes
  stale).
- Lives under `docs/spikes/` so it is outside the build/test globs; it is a demo, not
  shipped code.
