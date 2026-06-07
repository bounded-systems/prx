---
---

internal: migrate `prx plan preflight` (a.k.a. `plan preflight`) off the cli.ts
monolith to a deps-bearing VerbSpec (`pr-state/plan-preflight-verb.ts`). Adds a
small `CliExitError` to the spine so a verb can map a failure to an explicit exit
code with no stdout — preflight uses it for exit 2 ("the check could not run")
distinct from exit 1 ("the check ran and refused") and 0 (pass). Behavior and
output are unchanged; the command now also projects to the MCP/OpenAPI surfaces.
No package change.
