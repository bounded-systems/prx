---
---

internal: migrate `prx overview` (and the `repo overview` / `scout overview`
aliases) off the cli.ts monolith to a deps-bearing VerbSpec
(`pr-state/overview-verb.ts`) via the VerbSpec deps seam. The inventory + status
reads become a small `OverviewDeps` slice (defaulted to reals, injected in
tests), removing the `overviewStatus` field from `CliDeps`. Slug resolution, the
cwd / --repo-path flow, diff-stat defaulting, and the current-branch dedup are
unchanged; the command now also projects to the MCP/OpenAPI surfaces. No package
change.
