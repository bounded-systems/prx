---
---

CI-only: the `publish-oci-boxes` repin job now pushes one fixed `auto-repin`
branch with `--force-with-lease` and reuses the open repin PR instead of minting
a SHA-derived branch (and a new PR) on every run (prx#1062). No package
codepath changes, so this changeset is empty.
