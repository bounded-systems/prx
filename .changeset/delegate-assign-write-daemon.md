---
"@bounded-systems/prx": patch
---

feat(delegate): route `delegate assign`'s WRITE through the daemon (GH-296)

`prx delegate assign` wrote the owner with host `bd assign <id> <name>` against
the per-clone `.beads`. The write now runs `prx beads update <id> --assignee
<name>` through the daemon (single writer; `bd assign` is shorthand for
`bd update --assignee`, empty string clears). A sync subprocess keeps
`runDelegateAssign` synchronous; the runner is injectable for tests. The
eligibility read (`runBdShow`) is a separate no-cache path for a later pass.
Toward removing host bd (prx-82b).
