---
"@bounded-systems/prx": patch
---

GH-411 slice 4: make the repo→commit-scope map config-driven instead of
hardcoding `bdelanghe/ai-home`. `inferOperatorScopeFromCwd` (the `--scope`
default for `prx intake`) now reads `scopeMap` from `~/.config/prx/config.json`
(e.g. `{"scopeMap": {"owner/repo": "prx"}}`) — unconfigured → `no-mapping`, so
the caller requires an explicit `--scope`. Adds a single shared operator-config
reader (`operator-config.ts`: `readOperatorConfig` / `readOperatorConfigStringMap`)
that `homeUpdate.inputs` (slice 3) now also uses, de-duplicating the config.json
parse. Repo-identity doc examples in `registry_store.ts` / `beads/hydrate.ts`
reworded off the personal repo to `example-owner/example-repo`.

Operator note: to keep `prx intake` auto-scoping your repo, add
`{"scopeMap": {"<owner>/<repo>": "prx"}}` to `~/.config/prx/config.json`.
