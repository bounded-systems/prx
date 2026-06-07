---
---

internal: extract `refreshTaskSignals` and `printStatus` from the cli.ts
monolith into a `pr-state/status-report.ts` leaf (Stage-0 of the §4
decomposition). Both were cli.ts-local but depend only on leaf modules
(task / github / contract), so peeling them out unblocks the `status` /
`transition` handlers from migrating to VerbSpecs without a cli.ts import cycle.
The `Output` type moves to the cli-types leaf. Pure move — no behavior change.
No package change.
