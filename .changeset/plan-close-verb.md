---
---

internal: add the `exitCode` projection to the VerbSpec spine (a successful run
can map its output to a non-zero CLI exit — refusal/drift — while MCP/OpenAPI
ignore it), and migrate `prx plan close` onto it as the first consumer. The
`planClose` driver (+ `planCloseReasonToGhReason` / `PlanCloseOptions` /
`PlanCloseDeps`) moves from cli.ts to the `plan-close-bd` leaf; the verb owns
parsing + framing via the deps seam. runSpecVerb now surfaces the first Zod
issue message (clean validation errors) for every verb. Behavior, the refusal
exit-1 semantics, and json/plain output are unchanged; the command now also
projects to the MCP/OpenAPI surfaces. No package change.
