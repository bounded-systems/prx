---
"@bounded-systems/prx": patch
---

`prx ci` accepts a `PRX_CI_LEDGER` override for the signing ledger, so it can sign in a bare CI checkout (where the workspace-resolved canonical ledger doesn't exist). `.github/workflows/ci.yml` uses it to sign each phase (gated on a `PRX_PROVENANCE_KEY` secret) and uploads the ledger as the chain's async mirror — so remote greens join the same signed chain as local ones. Fully no-op without the secret. (GH-352)
