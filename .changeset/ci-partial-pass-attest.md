---
"@bounded-systems/prx": patch
---

`prx ci` now records a signed `ci/phase/v1` derivation for each phase that *passed* even on a partial (failed) run — not only on a fully green run — so a failure still leaves verified, content-addressed evidence for the phases before it (absence of a phase's derivation ≡ that phase not verified). (GH-352)
