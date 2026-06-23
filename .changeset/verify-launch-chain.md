---
---

Add `verifyLaunchChain` (`provenance/verify-chain.ts`): verify the L3 write → L2
launch chain — the L3 verifies under the keeper key and attests the commit, the L2
verifies under the launcher key, both have the right `level`, and the L3 links back
to exactly this L2 by content-address (in-toto DAG). The verifier side of
`manifestDigest` enforcement; bumps `@bounded-systems/ocap-provenance` to `^0.2.0`
(for `./attestation`). Producer wiring (launch-flow call + distribution + the L3
carrying the launch link) is the remaining integration. No release.
