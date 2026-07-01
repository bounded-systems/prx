---
"@bounded-systems/prx": patch
---

`resolveWorkspaceAffinity` (the pre-flight guard on `prx beads` writes) now derives "what's served" from the same `resolveBeadsEndpoint` git-common-dir resolution a write actually dials (prx-z7of), instead of an independent, stale singleton lookup. That mismatch was the root cause of writes refusing with `daemon serves "<other-repo>"` even when the daemon was correctly configured for the calling repo (prx-9e86).
