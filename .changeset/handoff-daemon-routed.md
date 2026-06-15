---
"@bounded-systems/prx": patch
---

Fix prx-44y: `prx handoff enqueue` reported `created` but the row never persisted (so `prx handoff status` showed "no rows"). The handoff queue's bd memory ops (`bd remember`/`memories`) went through raw `execBd`, which from a worktree never reaches the one canonical clone the daemon owns — a phantom write.

The handoff store now routes those ops through the beadsd daemon via a synchronous `execBd`-shaped adapter that spawns `prx beads <subcommand>` (reaching canonical through `withBeadsClient`). Keeping it synchronous preserves `claimHandoff`'s read-then-write best-effort CAS exactly (no async window introduced). Adds the `prx beads recall | memories | remember` CLI verbs (over the memory surface added to the daemon contract earlier) and maps the memory reads in the door dialer; `remember` (a write) fails closed over the read door like every other write.

Existing handoff store/drain/cli tests pass unchanged (the adapter keeps the `execBd` injection seam), with new coverage for the adapter, the CLI verbs, and the dialer mappings.
