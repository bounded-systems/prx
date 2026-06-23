---
---

Add an end-to-end test for the L2→L3 capability chain on the prx side: store a
signed L2 in the **real CAS** (`storeLaunchAttestation`), then run the submit gate
with **no injected resolver** so the gate's default (`resolveLaunchAttestationFromCas`)
fetches the L2 by the L3's launch link and `verifyLaunchChain` runs — PR opens on a
valid chain, fail-closed when the L2 is absent. Exercises distribution + gate +
verify with no mocks. No release.
