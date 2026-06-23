---
---

Complete `refs/notes/provenance` end-to-end: `runKeeperDoorPush` now requests
`notesRef: "provenance"` (door-kit `^0.3.0`), so keeper writes project the signed
L3 onto the pushed commit as a git note — provenance travels with the repo
(`git notes show` / `git log --show-notes` / `git blame` → commit → note).
Also fixes `verifyL3Attestation`'s `canonicalJson` to sort-then-`JSON.stringify`
(stable across the JSON round-trip the L3 always makes before verification; the
prior form diverged on `undefined` fields) and re-pins `keeperd-room` to the
round-trip-stable door-keeper image. No release.
