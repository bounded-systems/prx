---
---

internal: migrate `prx pr-comments` (a.k.a. `repo pr-comments` / `scout
comments`) off the cli.ts monolith to a deps-bearing VerbSpec
(`pr-state/pr-comments-verb.ts`). One verb covers both actions — `show` and
`resolve` (thread ids as variadic positionals + repeatable `--thread`, plus
`--all-unresolved`) — with the JSON snapshot write on `--write`/`--output` and
the unresolved-threads→exit-1 mapping (the `exitCode` projection). Removes the
`fetchPrComments`/`resolvePrReviewThreads` fields from `CliDeps`. Behavior and
output unchanged; the command now also projects to the MCP/OpenAPI surfaces. No
package change.
