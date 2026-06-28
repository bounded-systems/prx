---
"@bounded-systems/prx": minor
---

Signed-derivation verification is now **on by default** (fail-closed) — trust
ledger row 6.1. Previously `PRX_REQUIRE_SIGNED_DERIVATIONS` was opt-in and the
merge-guard / publisher tier skipped verification entirely when it was unset
(fail-open). Now an unset/empty value enforces verification, and the gate fails
closed when a signed derivation is missing, invalid, or unverifiable.

Migration: this can block merge/publish in environments without a verifier
configured (`PRX_PROVENANCE_PUBKEY`) or that don't emit signed push
attestations. To opt out where enforcement can't yet be satisfied, set
`PRX_REQUIRE_SIGNED_DERIVATIONS=0` (also accepts `false`/`off`/`no`). The
fail-closed error messages now name both the fix and the opt-out.
