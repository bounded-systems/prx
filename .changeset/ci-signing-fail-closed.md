---
"@bounded-systems/prx": patch
---

`prx ci` is now fail-closed on signing (GH-352): local dev is the production surface, so wherever a provenance ledger is in scope (a reserved work-unit, or `PRX_CI_LEDGER` in CI) and no `PRX_PROVENANCE_KEY` is set, the run fails with a clear, actionable message (`set PRX_PROVENANCE_KEY=dev` for the zero-config local signer, or `ed25519:<b64>` for a shared/CI key) instead of silently skipping. Outside a signing context it is unchanged. `.github/workflows/ci.yml` sets `PRX_CI_LEDGER` only when the secret is present, so the `ci` job stays green until remote signing is switched on.
