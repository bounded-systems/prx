---
---

internal: migrate `prx worktree` (status) and `prx worktrees` (list) off the
cli.ts monolith to deps-bearing VerbSpecs (`pr-state/worktree-verb.ts`) via the
VerbSpec deps seam. Each wraps a single github.ts status read as its small deps
slice (defaulted to reals, injected in tests), removing the `worktreeStatus`
field from `CliDeps`. Behavior and output are unchanged; `worktree remove` stays
on the legacy handler. The commands now also project to the MCP/OpenAPI surfaces.
No package change.
