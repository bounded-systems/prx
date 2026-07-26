---
"@bounded-systems/prx": patch
---

Repoint `prx intake bd memory ls|get|set` off beads onto agent-memory (GH-1009).
The three memory verbs no longer route through `execBd` (`bd memories`/`recall`/
`remember`); they go through a new `MemoryPort` that spawns the `agent-memory`
binary (a fully separate, dolt-server-backed capability). `agent-memory` resolves
on PATH (`PRX_MEMORY_BIN`); memories are scoped to one agent id (`PRX_MEMORY_AGENT`,
default `prx`). No user-facing verb or output change for the plain path; `--json`
now emits agent-memory's shape.
