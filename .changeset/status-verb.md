---
---

internal: migrate `prx status` off the cli.ts monolith to a spec-driven VerbSpec
(`pr-state/status-verb.ts`), backed by the status-report leaf. The leaf's
`printStatus` is refactored into a string-returning `renderStatus` (printStatus
kept as a thin sink wrapper for the legacy `transition` handler). The
missing-contract ENOENT now maps to the friendly `prx contract init` hint inside
runSpecVerb, so every contract-reading verb benefits. Behavior and output are
unchanged; the command now also projects to the MCP/OpenAPI surfaces. No package
change.
