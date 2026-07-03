# Spike — signed ref-snapshot + artifact provenance (OCAP-grade repo identity)

> **Type:** code spike / POC &nbsp;·&nbsp; **Bead:** `prx-eydi` (epic `prx-0wsf`, design capture `prx-eyff`)

A ~230-line runnable proof of the two-assertion model for provenance verification:

```
artifact digest
    ── trusted build provenance ──▶ commit C
    ── trusted forge assertion   ──▶ C was refs/heads/main in repository R
                                     signed by the repository authority
```

Today prx derives repo/host "identity" (dolt database names, dolt server ids,
workspace ledger ids, canonical bare/worktree paths) entirely from parsing a git
remote URL string. That's fine for filesystem placement, but it proves nothing
cryptographically — a string match is not an **OCAP** (object capability: an
unforgeable reference granting specific authority over a specific object), it's
a lookup. This spike builds the real thing, with **two independent signers**:

- The **repository authority** signs a ref-snapshot: "`refs/heads/main` ==
  commit `C` in repo `R`, observation sequence `N`" — the local equivalent of a
  signed push certificate or a signed git tag over a branch-head observation.
- The **builder** signs SLSA-shaped artifact provenance binding an artifact
  digest to a commit, and **references the ref-snapshot's digest** rather than
  asserting its own unverified claim about which branch that commit came from.

Verification requires both signatures to check out, over both the *linkage*
(provenance references the exact ref-snapshot digest presented) and the
*content* (repo/ref/commit fields actually match what's expected). Same
"no signed X → no Y" rule as
[`docs/spikes/signed-prompt-evolution/`](../signed-prompt-evolution/), applied
to provenance instead of prompt promotion — same
`@bounded-systems/anchored-chain` primitives, no new crypto.

Everything is deterministic and offline ($0): stub commit/artifact digests, and
the **real** ed25519 primitives from the production chain
(`generateEd25519Keypair`, `ed25519Signer`/`ed25519Verifier`, `dssePae`,
`digestManifest`, `Derivation`).

## Run

```sh
bun docs/spikes/signed-ref-snapshot/poc.ts
```

**Setup note:** `docs/spikes/` isn't part of this repo's bun workspaces
(`["packages/*"]` only), so `@bounded-systems/anchored-chain` doesn't resolve
from here out of the box — same pre-existing gap affects
`signed-prompt-evolution/` too. Locally this was worked around with a manual
symlink (`node_modules/@bounded-systems/{anchored-chain,cas}` →
`packages/prx/node_modules/@bounded-systems/{anchored-chain,cas}`); that's not
committed (`node_modules` is gitignored) and isn't a real fix. Worth its own
follow-up if these spikes are meant to run from a fresh clone as documented.

## Output

```
── signed ref-snapshot + artifact provenance ───────────────────────
repository=urn:uuid:8b9d2e10-…  ref=refs/heads/main  commit=abc123def456
authority.keyid=eaf88fc791ad9978…  builder.keyid=89f006bbb9016c8c…

authority.sign  ref-snapshot=sha256:299c9… signed
builder.sign    provenance=sha256:6cfb9… signed
verify.happy    OK — verified — refs/heads/main == abc123def456 in urn:uuid:8b9d2e10-1c3a-4b7e-9f2d-6a1c0e4f5a3b
tamper.snapshot DENIED — ref-snapshot signature does not verify
tamper.artifact DENIED — artifact digest does not match provenance subject
forged.key      DENIED — provenance does not reference the presented ref-snapshot
forged.unlinked DENIED — provenance does not reference the presented ref-snapshot
```

## What it shows

1. **Two signers, two keys, one verification rule.** The repository authority
   and the builder never share a key. The verifier checks both signatures
   independently and checks that they're actually *linked* (provenance names
   the exact ref-snapshot digest, not just "trust me, it was main").
2. **Tampering is denied by cryptography, not policy.** A forged commit inside
   the ref-snapshot, a swapped artifact under an otherwise-valid provenance, a
   ref-snapshot signed by an untrusted key, and provenance that never
   referenced the presented snapshot at all — all four are denied at
   verification time, not by trusting whoever asserted them.
3. **Transport security is a separate concern, deliberately not modeled here.**
   Authenticating *who* connected to fetch/push (SSH/HTTPS) says nothing about
   whether a commit was actually the branch head at build time — that's what
   this signed ref-snapshot is for. The two layers compose but don't
   substitute for each other.

## Caveats / next steps

- `sequence` (the observation counter) is minted but not checked against a
  monotonic high-water mark here — a real implementation needs a
  `DerivationStore` (or equivalent) tracking the last-observed sequence per
  `(repository, ref)` so a stale, previously-valid ref-snapshot can't be
  replayed as if it were current.
- The `repository-authority` role is separate from ordinary push/write access
  in this model (two distinct keys), but this spike doesn't model an ordinary
  `RepositoryWriter` who can push but holds no signing key at all — see
  `prx-0wsf`'s notes for the fuller role partition (Reader/Writer/Admin/
  Authority) this is meant to fit into.
- Real integration means minting the ref-snapshot from an actual
  `post-receive`/signed-push hook (or a signed git tag) rather than a stub
  `mintRefSnapshot` call, and wiring `canonicalDoltDatabase`/workspace-ledger/
  dolt-server identity (today's string-derived `legacyGithubIdentitySegments`)
  onto a real `repo_id` once one exists, per `prx-eyff`.
- Lives under `docs/spikes/` so it is outside the build/test globs; it is a
  demo, not shipped code.
