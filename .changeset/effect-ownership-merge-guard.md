---
---

Enforce effect ownership in the merge-guard provenance axis (prx-6s8). The merge
gate (`projectProvenanceAxis`, read by `canEnterReadyToMerge`) verified each
derivation's signature but not its ownership, so a signature-valid `push/v1`
produced by a non-owning actor (e.g. `reviewer`) returned `verified`. It now
calls `verifyEffectOwnership` after the signature check: under enforcement, an
authentic-but-unowned effect fails closed (`unsigned`). Non-effect derivations
and non-role producers pass through unchanged; with enforcement off
(`PRX_REQUIRE_SIGNED_DERIVATIONS` unset) behavior is unchanged. No API change,
no release.
