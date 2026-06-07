---
"@bounded-systems/prx": patch
---

ci(coverage): add a per-file coverage ratchet (every src/ file ≥ 80%) alongside the global 85% gate

`coverage-summary.ts` gains `--per-file-min <pct>`: every product source file
(`packages/**/src/**`, tests excluded) must clear the floor unless it is in
`PER_FILE_BASELINE`. The baseline only SHRINKS — a baselined file that climbs
to/above the floor (or is deleted) goes "stale" and fails the gate, so fixing a
file forces dropping its baseline entry. The coverage workflow runs the gates at
`--min 85 --per-file-min 80`; the seven currently-exempt files (deprecated tui,
the in-decomposition cli.ts/cli-spawn, the triage haiku files pending #502, and
session/open) are baselined with reasons.
