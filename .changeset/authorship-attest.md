---
"@bounded-systems/prx": minor
---

Add `attestAuthorship` — project keeperd's L3 authorship reconciliation into the prx provenance ledger (prx-sfco, first slice).

keeperd's signed L3 records AI-vs-human authorship under `predicate.authorship`
(GitAI Phase 2, prx-ydib). `attestAuthorship` records a `prx.dev/authorship/v1`
derivation for it via `persistAttestation` — mirroring `scout-attest` /
`ci-attest`:

- **subject** = the commit (`gitCommit`).
- **resolvedDependencies** = `l3` (sha256 of keeperd's signed L3 envelope) — so
  keeperd's commit-key signature is preserved as a content-addressed input
  rather than re-signed; this derivation is the index/lineage entry.
- **params** = the reconciled verdict `{ model?, aiAuthored, divergent, stale }`;
  `divergent` (staged-but-unclaimed = bypass) is the high-signal set.

Content-addressed + idempotent + signed; verifiable via `verifySlsaEnvelope`.
Follow-ups (prx-sfco): a `refs/notes/<ref>` reader that parses the L3 note,
sync-agent wiring (prx-697) to publish, and the trust-ledger `CLAIMS.md` row
(also closes the "off-the-shelf verifiability" Partial, prx-5lcd).
