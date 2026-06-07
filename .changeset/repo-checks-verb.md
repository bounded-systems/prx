---
---

internal: migrate `prx repo-checks` (a.k.a. `repo checks` / `scout checks`) off
the cli.ts monolith to a deps-bearing VerbSpec (`pr-state/repo-checks-verb.ts`)
using the `exitCode` projection — an empty check list exits 1, exactly as the
legacy handler returned. Removes the `repoCheckNames` field from `CliDeps`.
Behavior and output are unchanged; the command now also projects to the
MCP/OpenAPI surfaces. No package change.
