---
---

internal: migrate `prx plan load` (a.k.a. `plan load`) off the cli.ts monolith to
a deps-bearing VerbSpec (`pr-state/plan-load-verb.ts`), completing the plan-store
group (save/show/load). Adds a small `renderRaw` projection (+ `Output.writeRaw`)
so a verb can emit exact bytes to stdout with no trailing newline — `plan load
--format=raw` writes the body verbatim; `--format=json` an envelope; the
approved→draft fallback note goes to stderr via `warnings`. The GH-1229-style
plan-load argparse tests are updated to the generic verb parsing. Behavior of the
read paths is unchanged; the command now also projects to the MCP/OpenAPI
surfaces. No package change.
