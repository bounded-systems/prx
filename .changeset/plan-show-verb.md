---
---

internal: migrate `prx plan show` (a.k.a. `plan show`) off the cli.ts monolith to
a deps-bearing VerbSpec (`pr-state/plan-show-verb.ts`) — `--paths` (CAS root +
staging dir) and the slot read (head preview / full json). As with the other
migrated plan verbs, `plan show --help` now renders the verb help and argv is
parsed generically (the GH-1227/1229 tests are updated to match — the bespoke
over-positional reorder hint is no longer emitted; non-zero exit is preserved).
Behavior of the read paths is unchanged; the command now also projects to the
MCP/OpenAPI surfaces. No package change.
