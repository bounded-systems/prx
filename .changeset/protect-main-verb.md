---
---

internal: migrate `prx protect-main` (a.k.a. `repo protect-main`) off the cli.ts
monolith to a deps-bearing VerbSpec (`pr-state/protect-main-verb.ts`). One verb
covers both paths — `--check` (drift report, exits 1 on mismatch via the
`exitCode` projection) and apply — with the `--strict`/deno-style `--allow`
derivation in `run` and repeated `--allow`/`--require-status-check` list flags.
The `--allow` parse helper was relocated via the extract-module codemod; the
`checkMainBranchProtection`/`protectMainBranch` fields leave `CliDeps`. Behavior
and output unchanged; the command now also projects to the MCP/OpenAPI surfaces.
No package change.
