---
---

Wire door-keeper L3 verification into `submit publish`'s `requireSigned` gate
(Phase B.2). The gate now branches on the attestation FORMAT: a door-keeper L3 is
verified via `verifyL3Attestation` against the operator-supplied keeper trust key
(`resolveKeeperTrustKey` / `PRX_KEEPER_PUBKEY`), failing closed when the key is
unconfigured, the signature is wrong, or the subject isn't the materialized
commit; prx's own anchored-chain `push/v1` derivation still verifies via the
existing DSSE path. Behaviour is unchanged unless `requireSigned` is set and the
door returns an L3. No public API change, no release.
