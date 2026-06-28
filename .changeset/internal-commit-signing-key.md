---
---

prx-e7cl: prx's OWN commit-signing key — internal to prx, never the host's
`~/.ssh` or a cloud KMS. New `provenance/commit-signing-key.ts` mirrors
`dev-key.ts`: a dedicated ed25519 SSH key under `<state>/prx/signing/id_ed25519`,
generate-on-first-use via `ssh-keygen` (through the proc seam — no hand-rolled
crypto), reused thereafter. A keeper launch activates default-on signing by
adding `PRX_COMMIT_SIGNING_KEY` to the child git env it builds (no raw
`process.env` writes). The keeper's `commit-tree` now **fails closed** when
signing is configured but the materialized commit is unsigned (`git %G?` is `N`)
— refusing to ship an unsigned keeper commit toward a signed-required base. The
git seam (already merged) does the SSH signing. Test-only mechanism + guard; no
behaviour change unless `PRX_COMMIT_SIGNING_KEY` is set.
