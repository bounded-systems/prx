---
---

Add `verifyL3Attestation` (`provenance/verify-l3.ts`): verify door-keeper's L3
attestation (SLSA statement + detached ed25519 over the statement JSON) and its
subject — the verify primitive that lets a thin prx accept door-keeper as the
canonical keeper daemon (Phase B.2). Not yet wired into the gate. Test-only
consumer for now; no API or behavior change, no release.
