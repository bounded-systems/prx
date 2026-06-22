---
---

Add `resolveKeeperTrustKey` (`provenance/keeper-trust.ts`): resolve the
operator-supplied keeper trust public key from `PRX_KEEPER_PUBKEY` (PEM literal
or path), fail-closed when absent/unreadable. Per the hardening decision the
anchor is never derived from the actor (no `getPublicKey` / image-bind). The
verify primitive (`verifyL3Attestation`, #734) pairs with this. Not yet wired
into the gate. No API or behavior change, no release.
