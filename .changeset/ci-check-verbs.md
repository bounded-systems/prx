---
---

internal: migrate `prx remote-ci-check` (a.k.a. `repo ci` / `scout ci`) and
`prx scout-logs` (`scout logs`) off the cli.ts monolith to deps-bearing
VerbSpecs (`pr-state/ci-check-verb.ts`) — the first non-throwing consumers of
the `exitCode` projection: failing checks map a successful run to exit 1, exactly
as the legacy handlers returned. Removes the `remoteCiCheck` / `scoutLogs` /
`resolveCurrentPrRef` fields from `CliDeps`. Behavior and output are unchanged;
the commands now also project to the MCP/OpenAPI surfaces. No package change.
