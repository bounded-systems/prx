---
"@bounded-systems/prx": patch
---

Default `programs.prx.provenance.enable` to true so the signer ships with the
binary that enforces it (#433). `ciSigningDecision` is fail-closed — a
provenance ledger in scope plus no signer is `fail` (exit 65), not `skip`, for
both `prx ci` (#396) and an in-pipeline `scout read` (#427). The home-manager
module and the released binary come from the same flake, so a deployment
picking up the signing release also picks up this default: with no `masterFile`
set it signs against the zero-config persisted dev master (the **bootstrap**
posture) instead of failing, and `prx provenance status` still reports the path
to the operator-master production posture. No binary behaviour changes —
`PRX_REQUIRE_SIGNED_DERIVATIONS` was already default-on when unset, so the
module's export of it is unchanged in effect. Set `enable = false` to opt out.
