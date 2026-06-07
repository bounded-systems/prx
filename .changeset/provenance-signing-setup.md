---
"@bounded-systems/prx": patch
---

Hardened provenance signing setup (GH-352): `scripts/setup-provenance-signing` (one-command `keymaker register` + drift check + posture report), a `programs.prx.provenance` home-manager option (declaratively wires `PRX_PROVENANCE_MASTER_FILE` / per-actor `PRX_PROVENANCE_KEY` / `PRX_REQUIRE_SIGNED_DERIVATIONS`), and `docs/provenance/signing.md` (the operator-master runbook — sops/agenix → per-actor keys → committable trust map → fail-closed enforcement). Also generalizes the markdown-coverage exclude to all package `CHANGELOG.md` files (changesets-managed).
