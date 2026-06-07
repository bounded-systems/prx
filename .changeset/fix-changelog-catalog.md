---
---

tests only: fix the markdown doc-catalog gate to exclude every
`packages/<name>/CHANGELOG.md` by rule (changesets-managed release logs),
instead of listing only `packages/prx`. `#394` generated bd/gh/git CHANGELOGs
that the gate didn't account for, turning main's `ci` red. No package change.
