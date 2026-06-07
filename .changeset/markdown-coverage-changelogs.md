---
"@bounded-systems/prx": patch
---

The markdown-coverage guard now excludes any `CHANGELOG.md` (changesets-managed per-package release logs) generically, instead of only `packages/prx/CHANGELOG.md`. A release had added `packages/bd|gh|git/CHANGELOG.md`, which the guard flagged as uncatalogued and turned `ci` red on every PR.
