---
"@bounded-systems/prx": patch
---

`resolveBeadsEndpoint` now requests `--path-format=absolute` from `git rev-parse --git-common-dir` (prx-d8hc). Without it, a normal (non-bare) checkout run from its own root gets back the bare relative string `.git`, and `join(".git", ".beads")` misses the real `.beads/` — a sibling of `.git`, not nested under it — so `prx beads ready`/`show`/etc. could never derive their own socket from such a checkout and fell through to other resolution paths instead.
