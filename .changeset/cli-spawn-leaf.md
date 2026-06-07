---
---

internal: extract the shared git/subprocess helpers (SpawnLike, tryCommand,
runCommand, resolveRepoRootWithSpawn, listResolvedWorktrees, …) from cli.ts to a
pr-state/cli-spawn.ts leaf — unblocks extracting the git-operation functions that
depend on them. No package version change.
