---
---

internal: migrate `prx plan save` (a.k.a. `plan save`) off the cli.ts monolith to
a deps-bearing VerbSpec (`pr-state/plan-save-verb.ts`) — the first real consumer
of the `warnings` (stderr) projection. The `--skip-validate` warning and the
GH-2028 persist-on-failure note/diagnostics become `warnings` (stderr); the sha
/ json the `render` (stdout); exit stays 0. Source resolution, `--cleanup`
parsing, and unit resolution move into the verb (using the cli-id leaf). Removes
the `readStdinSync`/`readPlanFile`/`statPath`/`unlinkPlanFile`/`renamePlanFile`
fields from `CliDeps`. Behavior and output unchanged; the command now also
projects to the MCP/OpenAPI surfaces. No package change.
