---
---

internal: migrate `prx transition` off the cli.ts monolith to a deps-bearing
VerbSpec (`pr-state/transition-verb.ts`) via the VerbSpec deps seam. The
non-deterministic git reads (branch / commit) are its small `TransitionDeps`
slice; `detectBranchNameFromCwd` moves to the cli-spawn leaf (it was cli.ts-local,
used by 5 sites). The dead `printStatus` sink wrapper is dropped from the
status-report leaf now that nothing uses it. Behavior, the `FAIL:` validation
errors, and json/plain output are unchanged; the command now also projects to
the MCP/OpenAPI surfaces. No package change.
