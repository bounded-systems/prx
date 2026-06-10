---
"@bounded-systems/prx": patch
---

Show an actionable hint instead of git's raw `fatal: not a git repository` when `prx next` (and other work-unit verbs) run outside a git working tree — e.g. a freshly provisioned sandbox that came up with no repo cloned. The hint points at `prx repo add <git-url>` / cd-into-a-worktree and `prx repo list`.
