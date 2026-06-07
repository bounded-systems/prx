---
"@bounded-systems/prx": patch
---

ci(coverage): add an 85% line-coverage gate + cover the last sub-80% files

`coverage-summary.ts` gains a `--min <pct>` flag that exits non-zero when parsed
line coverage is below the threshold; the coverage workflow now runs it with
`--min 85`, so the `coverage` job fails below the 85% floor (the project sits at
~87%). Also raises the remaining sub-80% files: `beads/workspace_mode` 77→96%
(probeSharedServerHasIssues + readBeadsMetadata arms), `tools/agent_doctor`
76→83% (classifyError categories + truncate), and `beads/migrate` 79→82%
(the non-embedded refusal modes).
