---
"@bounded-systems/prx": minor
---

Write-side workspace-affinity guard for daemon-routed beads (prx-9e86). The
host-global beadsd serves ONE clone, so a `prx beads create/update/close/dep`
issued from a worktree whose bd prefix differs from the served clone's prefix
would land in the WRONG repo's beads (the root cause of 54 supply-chain tasks
created with `prx-` ids from the supply-plan-design worktree). `prx beads`
writes now **fail closed** on that mismatch (nonzero exit, actionable message),
and reads **warn** (non-fatal). The served prefix is reported by the daemon on
every reply (`servedPrefix` on the wire contract), so the read-side check costs
only a cheap cwd index read — no `bd config` subprocess. Both prefixes must be
known for a mismatch, so an unregistered cwd is never blocked. Local path only;
a `--vm` daemon serves its own workspace.
