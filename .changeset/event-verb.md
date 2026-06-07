---
---

internal: migrate `prx event` (a.k.a. `contract event`) off the cli.ts monolith
to a deps-bearing VerbSpec (`pr-state/event-verb.ts`). The skill-event apply
logic — advance on a valid transition, record a blocked-transition observation
otherwise, append a transition-log entry — moves into a shared `applySkillEvent`
helper that the verb (logging) and the legacy `contract` command (pr-contract,
no log) both call. Folds `event` into the `contract <sub>` alias routing.
Behavior and output unchanged; the command now also projects to the MCP/OpenAPI
surfaces. No package change.
