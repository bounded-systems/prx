---
---

Add L2 launch-attestation distribution (`provenance/launch-store.ts`):
`storeLaunchAttestation` writes a signed L2 into the CAS keyed by its
content-address (`l2LaunchDigest`), and `resolveLaunchAttestationFromCas` fetches
it by an L3 write's launch link — now the `submit publish` gate's **default**
`resolveLaunchAttestation`. So with `PRX_LAUNCH_PUBKEY` set, the gate resolves +
verifies the L3→L2 chain from the ledger (in-toto DAG, content-addressed). No release.
