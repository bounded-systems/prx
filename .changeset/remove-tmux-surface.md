---
"@bounded-systems/prx": patch
---

refactor: remove the tmux parity surface, the tmux/session board actions, and the `prx prune session` command (slice 2 of removing tmux entirely). The board projection no longer reads or stamps a tmux session surface; disposition classifies a unit as complete on the four durable surfaces (worktree + local branch + remote branch + PR) without requiring a tmux session; `worktree-remove` no longer tears down a tmux session; and the `tmux` actor + its reconcile events/facts are dropped from the machine catalog. The interactive `prx review` send-keys path and the `prx-mux` package are removed in later slices. (`prx prune` itself is slated for replacement by `gc`.)
